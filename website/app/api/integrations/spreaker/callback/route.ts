import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decryptCredential, encryptCredential } from "@/lib/server/credential-vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function finish(request: NextRequest, result: string) {
  const response = NextResponse.redirect(new URL(`/dashboard/api-connections?spreaker=${encodeURIComponent(result)}`, request.url));
  response.cookies.set("spreaker_oauth_state", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/integrations/spreaker/callback",
    maxAge: 0,
  });
  return response;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return finish(request, "please-sign-in");

  const query = request.nextUrl.searchParams;
  const state = query.get("state") ?? "";
  const expectedState = request.cookies.get("spreaker_oauth_state")?.value ?? "";
  if (!state || !expectedState || state !== expectedState) return finish(request, "state-check-failed");
  if (query.get("error")) return finish(request, "authorization-cancelled");

  const code = query.get("code");
  if (!code) return finish(request, "missing-oauth-configuration");
  const { data: stored, error: storedError } = await supabase.rpc("get_integration_credential", { p_provider: "spreaker" });
  const row = Array.isArray(stored) ? stored[0] : stored;
  if (storedError || !row) return finish(request, "missing-oauth-configuration");
  let app: { client_id?: string; client_secret?: string };
  try { app = JSON.parse(decryptCredential(row)); }
  catch { return finish(request, "missing-oauth-configuration"); }
  const clientId = app.client_id;
  const clientSecret = app.client_secret;
  if (!clientId || !clientSecret) return finish(request, "missing-oauth-configuration");

  const redirectUri = process.env.SPREAKER_REDIRECT_URI
    || new URL("/api/integrations/spreaker/callback", request.url).toString();

  try {
    const body = new FormData();
    body.set("grant_type", "authorization_code");
    body.set("client_id", clientId);
    body.set("client_secret", clientSecret);
    body.set("redirect_uri", redirectUri);
    body.set("code", code);
    const tokenResponse = await fetch("https://api.spreaker.com/oauth2/token", {
      method: "POST",
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    const payload = await tokenResponse.json().catch(() => ({}));
    const tokens = payload?.response ?? payload;
    if (!tokenResponse.ok || typeof tokens?.access_token !== "string" || !tokens.access_token) {
      return finish(request, "token-exchange-failed");
    }

    const meResponse = await fetch("https://api.spreaker.com/v2/me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!meResponse.ok) return finish(request, "account-verification-failed");

    const expiresIn = Number(tokens.expires_in);
    const bundle = {
      client_id: clientId,
      client_secret: clientSecret,
      access_token: tokens.access_token as string,
      refresh_token: typeof tokens.refresh_token === "string" ? tokens.refresh_token : undefined,
      token_type: typeof tokens.token_type === "string" ? tokens.token_type : "Bearer",
      scope: typeof tokens.scope === "string" ? tokens.scope : "basic",
      expires_at: Number.isFinite(expiresIn) && expiresIn > 0
        ? Math.floor(Date.now() / 1000) + expiresIn
        : undefined,
    };
    const encrypted = encryptCredential(JSON.stringify(bundle));
    const { error: saveError } = await supabase.rpc("save_integration_credential", {
      p_provider: "spreaker",
      p_ciphertext: encrypted.ciphertext,
      p_iv: encrypted.iv,
      p_auth_tag: encrypted.auth_tag,
      p_key_version: encrypted.key_version,
    });
    if (saveError) return finish(request, "credential-save-failed");

    const { error: statusError } = await supabase.from("integration_connections").upsert({
      owner_id: user.id,
      provider: "spreaker",
      status: "connected",
      masked_suffix: bundle.access_token.slice(-4),
      updated_at: new Date().toISOString(),
    }, { onConflict: "owner_id,provider" });
    if (statusError) return finish(request, "connection-status-save-failed");

    return finish(request, "connected");
  } catch {
    return finish(request, "connection-failed");
  }
}
