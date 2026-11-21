import { createClient } from "@/lib/supabase/server";
import { decryptCredential, encryptCredential } from "@/lib/server/credential-vault";

type SupabaseServer = Awaited<ReturnType<typeof createClient>>;

type SpreakerTokenBundle = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_at?: number;
};

function parseTokenBundle(serialized: string): SpreakerTokenBundle {
  try {
    const parsed = JSON.parse(serialized) as Partial<SpreakerTokenBundle>;
    if (parsed && typeof parsed.access_token === "string" && parsed.access_token) {
      return parsed as SpreakerTokenBundle;
    }
  } catch {
    // Backward compatibility for the earlier single access-token field.
  }
  return { access_token: serialized };
}

async function persistBundle(supabase: SupabaseServer, bundle: SpreakerTokenBundle) {
  const encrypted = encryptCredential(JSON.stringify(bundle));
  const { error } = await supabase.rpc("save_integration_credential", {
    p_provider: "spreaker",
    p_ciphertext: encrypted.ciphertext,
    p_iv: encrypted.iv,
    p_auth_tag: encrypted.auth_tag,
    p_key_version: encrypted.key_version,
  });
  if (error) throw new Error("Could not securely save the refreshed Spreaker token.");

  await supabase.from("integration_connections").upsert({
    provider: "spreaker",
    status: "connected",
    masked_suffix: bundle.access_token.slice(-4),
    updated_at: new Date().toISOString(),
  }, { onConflict: "owner_id,provider" });
}

export async function getUsableSpreakerAccessToken(supabase: SupabaseServer): Promise<string> {
  const { data, error } = await supabase.rpc("get_integration_credential", {
    p_provider: "spreaker",
  });
  if (error) throw new Error("Spreaker credentials are not available. Apply the latest database migrations.");
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("Connect your Spreaker account first.");

  let bundle = parseTokenBundle(decryptCredential(row));
  if (!bundle.access_token) throw new Error("The saved Spreaker token is empty.");

  const expiresSoon = typeof bundle.expires_at === "number" && bundle.expires_at <= Math.floor(Date.now() / 1000) + 120;
  if (!expiresSoon) return bundle.access_token;

  const clientId = process.env.SPREAKER_CLIENT_ID;
  const clientSecret = process.env.SPREAKER_CLIENT_SECRET;
  if (!bundle.refresh_token || !clientId || !clientSecret) {
    throw new Error("The Spreaker access token has expired. Reconnect Spreaker to continue.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: bundle.refresh_token,
  });
  const response = await fetch("https://api.spreaker.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  const tokens = payload?.response ?? payload;
  if (!response.ok || typeof tokens?.access_token !== "string" || !tokens.access_token) {
    throw new Error("Spreaker could not refresh the access token. Reconnect your Spreaker account.");
  }

  const expiresIn = Number(tokens.expires_in);
  bundle = {
    access_token: tokens.access_token,
    refresh_token: typeof tokens.refresh_token === "string" ? tokens.refresh_token : bundle.refresh_token,
    token_type: typeof tokens.token_type === "string" ? tokens.token_type : bundle.token_type ?? "Bearer",
    scope: typeof tokens.scope === "string" ? tokens.scope : bundle.scope,
    expires_at: Number.isFinite(expiresIn) && expiresIn > 0
      ? Math.floor(Date.now() / 1000) + expiresIn
      : undefined,
  };
  await persistBundle(supabase, bundle);
  return bundle.access_token;
}
