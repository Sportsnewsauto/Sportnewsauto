import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decryptCredential, encryptCredential } from "@/lib/server/credential-vault";
import { getUsableSpreakerAccessToken } from "@/lib/server/spreaker-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const providers = ["spreaker", "groq", "gemini"] as const;
type Provider = typeof providers[number];

function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && providers.includes(value as Provider);
}

function providerInfoLabel(provider: Provider): string {
  return provider === "spreaker" ? "Spreaker" : provider === "groq" ? "Groq" : "Google Gemini";
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

  if (request.nextUrl.searchParams.get("resource") === "spreaker-shows") {
    const { data: stored, error: readError } = await supabase.rpc("get_integration_credential", { p_provider: "spreaker" });
    if (readError) return NextResponse.json({ error: "Spreaker credential lookup is not available. Apply the latest Supabase migration 0002." }, { status: 503 });
    const row = Array.isArray(stored) ? stored[0] : stored;
    if (!row) return NextResponse.json({ error: "Save and verify your Spreaker credential first." }, { status: 404 });

    let token: string;
    try { token = await getUsableSpreakerAccessToken(supabase); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not decrypt the Spreaker credential.";
      return NextResponse.json({ error: message }, { status: 503 });
    }

    const headers = { Authorization: `Bearer ${token}` };
    try {
      const meResponse = await fetch("https://api.spreaker.com/v2/me", {
        headers, cache: "no-store", signal: AbortSignal.timeout(8000),
      });
      if (!meResponse.ok) return NextResponse.json({ error: "Spreaker rejected the saved token. Verify it again." }, { status: 422 });
      const mePayload = await meResponse.json();
      const userId = mePayload?.response?.user?.user_id;
      if (!userId || !/^\\d+$/.test(String(userId))) {
        return NextResponse.json({ error: "Spreaker did not return a valid account ID." }, { status: 502 });
      }

      // Spreaker paginates show lists (up to 100 per page). Follow its
      // next_url so customers with many shows can still select the right one.
      const shows: { show_id: string; title: string; site_url: string }[] = [];
      const visited = new Set<string>();
      let nextUrl: string | null =
        `https://api.spreaker.com/v2/users/${encodeURIComponent(String(userId))}/shows?filter=editable&limit=100`;
      for (let page = 0; page < 20; page += 1) {
        const currentPageUrl: string | null = nextUrl;
        if (!currentPageUrl) break;
        if (!currentPageUrl.startsWith("https://api.spreaker.com/") || visited.has(currentPageUrl)) {
          return NextResponse.json({ error: "Spreaker returned an invalid show-list page link." }, { status: 502 });
        }
        visited.add(currentPageUrl);
        const showsResponse: Response = await fetch(currentPageUrl, {
          headers, cache: "no-store", signal: AbortSignal.timeout(8000),
        });
        if (!showsResponse.ok) {
          return NextResponse.json({ error: "Could not retrieve editable Spreaker shows for this account." }, { status: 502 });
        }
        const showsPayload = await showsResponse.json();
        const items = Array.isArray(showsPayload?.response?.items) ? showsPayload.response.items : [];
        shows.push(...items
          .filter((item: any) => item && /^\\d+$/.test(String(item.show_id)) && typeof item.title === "string")
          .map((item: any) => ({
            show_id: String(item.show_id),
            title: item.title,
            site_url: typeof item.site_url === "string" ? item.site_url : "",
          })));
        const candidate = showsPayload?.response?.next_url;
        nextUrl = typeof candidate === "string" && candidate ? candidate : null;
      }
      return NextResponse.json({ shows }, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return NextResponse.json({ error: "Could not reach Spreaker right now. Try again." }, { status: 502 });
    }
  }

  const { data, error } = await supabase
    .from("integration_connections")
    .select("provider,status,masked_suffix,updated_at")
    .eq("owner_id", user.id);
  if (error) return NextResponse.json({ error: "Integration storage is not ready. Apply Supabase migration 0002 first." }, { status: 503 });
  return NextResponse.json({ connections: data ?? [] }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return NextResponse.json({ error: "Cross-site requests are not allowed." }, { status: 403 });
  }

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid request body." }, { status: 400 }); }
  const input = body as { provider?: unknown; secret?: unknown; action?: unknown; clientId?: unknown; clientSecret?: unknown; showId?: unknown };
  if (!isProvider(input?.provider)) {
    return NextResponse.json({ error: "Choose a valid provider." }, { status: 400 });
  }

  if (input.provider === "spreaker" && input.action === "save-show") {
    const showId = typeof input.showId === "string" ? input.showId.trim() : "";
    if (!/^\\d{1,20}$/.test(showId)) {
      return NextResponse.json({ error: "Enter a valid numeric Spreaker Show ID." }, { status: 400 });
    }

    let token: string;
    try { token = await getUsableSpreakerAccessToken(supabase); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not read the connected Spreaker account.";
      return NextResponse.json({ error: message }, { status: 422 });
    }

    const headers = { Authorization: `Bearer ${token}` };
    try {
      const meResponse = await fetch("https://api.spreaker.com/v2/me", {
        headers, cache: "no-store", signal: AbortSignal.timeout(8000),
      });
      if (!meResponse.ok) {
        return NextResponse.json({ error: "Spreaker rejected the connected account. Reconnect Spreaker and try again." }, { status: 422 });
      }
      const mePayload = await meResponse.json();
      const userId = mePayload?.response?.user?.user_id;
      if (!userId || !/^\\d+$/.test(String(userId))) {
        return NextResponse.json({ error: "Spreaker did not return a valid account ID." }, { status: 502 });
      }

      // Confirm the typed ID is one of this authenticated account's editable
      // shows before saving it as the destination for automatic publishing.
      const visited = new Set<string>();
      let nextUrl: string | null =
        `https://api.spreaker.com/v2/users/${encodeURIComponent(String(userId))}/shows?filter=editable&limit=100`;
      let matchedShow: { show_id: string; title: string } | null = null;
      for (let page = 0; page < 20; page += 1) {
        const currentPageUrl: string | null = nextUrl;
        if (!currentPageUrl) break;
        if (!currentPageUrl.startsWith("https://api.spreaker.com/") || visited.has(currentPageUrl)) {
          return NextResponse.json({ error: "Spreaker returned an invalid show-list page link." }, { status: 502 });
        }
        visited.add(currentPageUrl);
        const showsResponse: Response = await fetch(currentPageUrl, {
          headers, cache: "no-store", signal: AbortSignal.timeout(8000),
        });
        if (!showsResponse.ok) {
          return NextResponse.json({ error: "Could not verify the Show ID against your Spreaker account." }, { status: 502 });
        }
        const showsPayload = await showsResponse.json();
        const items = Array.isArray(showsPayload?.response?.items) ? showsPayload.response.items : [];
        const match = items.find((item: any) => String(item?.show_id ?? "") === showId);
        if (match) {
          matchedShow = { show_id: showId, title: typeof match.title === "string" ? match.title : "Your Spreaker show" };
          break;
        }
        const candidate = showsPayload?.response?.next_url;
        nextUrl = typeof candidate === "string" && candidate ? candidate : null;
      }

      if (!matchedShow) {
        return NextResponse.json({
          error: "That Show ID was not found in your Spreaker account's editable shows. Check the number or connect the Spreaker account that owns or can edit this show.",
        }, { status: 422 });
      }

      const { error: settingsError } = await supabase.from("workspace_settings").upsert({
        owner_id: user.id,
        spreaker_show_id: showId,
        updated_at: new Date().toISOString(),
      }, { onConflict: "owner_id" });
      if (settingsError) {
        return NextResponse.json({ error: "The Show ID was verified, but could not be saved to this workspace." }, { status: 503 });
      }
      return NextResponse.json({
        success: true,
        show_id: matchedShow.show_id,
        show_title: matchedShow.title,
        message: `Spreaker show “${matchedShow.title}” (ID ${showId}) verified and saved.`,
      }, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return NextResponse.json({ error: "Could not reach Spreaker to verify this Show ID. Try again." }, { status: 502 });
    }
  }

  if (input.provider === "spreaker" && input.action === "save-app") {
    const clientId = typeof input.clientId === "string" ? input.clientId.trim() : "";
    const clientSecret = typeof input.clientSecret === "string" ? input.clientSecret.trim() : "";
    if (clientId.length < 3 || clientId.length > 512 || clientSecret.length < 8 || clientSecret.length > 4096 || /[\\r\\n]/.test(clientId + clientSecret)) {
      return NextResponse.json({ error: "Enter a valid Spreaker Client ID and Client Secret." }, { status: 400 });
    }
    let encrypted;
    try { encrypted = encryptCredential(JSON.stringify({ client_id: clientId, client_secret: clientSecret })); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : "Credential vault is not configured.";
      return NextResponse.json({ error: message }, { status: 503 });
    }
    const { error: saveError } = await supabase.rpc("save_integration_credential", {
      p_provider: "spreaker",
      p_ciphertext: encrypted.ciphertext,
      p_iv: encrypted.iv,
      p_auth_tag: encrypted.auth_tag,
      p_key_version: encrypted.key_version,
    });
    if (saveError) return NextResponse.json({ error: "Could not securely save your Spreaker app credentials." }, { status: 503 });
    const { error: statusError } = await supabase.from("integration_connections").upsert({
      owner_id: user.id, provider: "spreaker", status: "saved_unverified",
      masked_suffix: clientId.slice(-4), updated_at: new Date().toISOString(),
    }, { onConflict: "owner_id,provider" });
    if (statusError) return NextResponse.json({ error: "App credentials saved, but connection status could not be updated." }, { status: 503 });
    return NextResponse.json({ success: true, message: "Your Spreaker Client ID and Client Secret are encrypted and saved to your account." }, { status: 201 });
  }

  if (input.action === "verify") {
    const { data: stored, error: readError } = await supabase.rpc("get_integration_credential", {
      p_provider: input.provider,
    });
    if (readError) return NextResponse.json({ error: "Credential lookup is not available. Apply the latest Supabase migration 0002." }, { status: 503 });
    const row = Array.isArray(stored) ? stored[0] : stored;
    if (!row) return NextResponse.json({ error: "Save a credential for this provider first." }, { status: 404 });

    let secret: string;
    try { secret = input.provider === "spreaker" ? await getUsableSpreakerAccessToken(supabase) : decryptCredential(row); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : "Could not decrypt this credential.";
      return NextResponse.json({ error: message }, { status: 503 });
    }

    const endpoints: Record<Provider, { url: string; headers: Record<string, string> }> = {
      spreaker: { url: "https://api.spreaker.com/v2/me", headers: { Authorization: `Bearer ${secret}` } },
      groq: { url: "https://api.groq.com/openai/v1/models", headers: { Authorization: `Bearer ${secret}` } },
      gemini: { url: "https://generativelanguage.googleapis.com/v1beta/models", headers: { "x-goog-api-key": secret } },
    };

    let providerResponse: Response;
    try {
      providerResponse = await fetch(endpoints[input.provider].url, {
        method: "GET",
        headers: endpoints[input.provider].headers,
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      return NextResponse.json({ error: "Could not reach the provider right now. Try verification again." }, { status: 502 });
    }

    const nextStatus = providerResponse.ok ? "connected" : "invalid";
    const { error: statusError } = await supabase.from("integration_connections").update({
      status: nextStatus,
      updated_at: new Date().toISOString(),
    }).eq("owner_id", user.id).eq("provider", input.provider);
    if (statusError) return NextResponse.json({ error: "Provider replied, but the connection status could not be updated." }, { status: 503 });

    if (!providerResponse.ok) {
      return NextResponse.json({ error: `${providerInfoLabel(input.provider)} rejected this credential (HTTP ${providerResponse.status}). Check the key and save it again.` }, { status: 422 });
    }
    return NextResponse.json({ success: true, message: `${providerInfoLabel(input.provider)} connection verified.` }, { headers: { "Cache-Control": "no-store" } });
  }

  if (typeof input.secret !== "string") {
    return NextResponse.json({ error: "Enter the API credential to save." }, { status: 400 });
  }
  const secret = input.secret.trim();
  if (secret.length < 10 || secret.length > 8192 || /[\r\n]/.test(secret)) {
    return NextResponse.json({ error: "The credential does not look valid. Check it and try again." }, { status: 400 });
  }

  let encrypted;
  try { encrypted = encryptCredential(secret); }
  catch (error) {
    const message = error instanceof Error ? error.message : "Credential vault is not configured.";
    return NextResponse.json({ error: message }, { status: 503 });
  }

  // The database function validates auth.uid() and atomically writes ciphertext.
  // The browser-facing role has no SELECT grant on the encrypted credential table.
  const { error: saveError } = await supabase.rpc("save_integration_credential", {
    p_provider: input.provider,
    p_ciphertext: encrypted.ciphertext,
    p_iv: encrypted.iv,
    p_auth_tag: encrypted.auth_tag,
    p_key_version: encrypted.key_version,
  });
  if (saveError) return NextResponse.json({ error: "Could not store this credential. Apply the latest Supabase migration 0002 and try again." }, { status: 503 });

  const { error: statusError } = await supabase.from("integration_connections").upsert({
    owner_id: user.id,
    provider: input.provider,
    status: "saved_unverified",
    masked_suffix: secret.slice(-4),
    updated_at: new Date().toISOString(),
  }, { onConflict: "owner_id,provider" });
  if (statusError) return NextResponse.json({ error: "Credential encrypted, but its connection status could not be saved." }, { status: 503 });

  return NextResponse.json({ success: true, message: "Credential encrypted and saved. Verify it before using it." }, { status: 201, headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return NextResponse.json({ error: "Cross-site requests are not allowed." }, { status: 403 });
  }
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

  const provider = request.nextUrl.searchParams.get("provider");
  if (!isProvider(provider)) return NextResponse.json({ error: "Choose a valid provider." }, { status: 400 });

  const { error } = await supabase.rpc("delete_integration_credential", { p_provider: provider });
  if (error) return NextResponse.json({ error: "Could not remove the saved credential. Apply Supabase migration 0003 if it has not been run." }, { status: 503 });
  const { error: statusError } = await supabase.from("integration_connections").delete().eq("owner_id", user.id).eq("provider", provider);
  if (statusError) return NextResponse.json({ error: "Credential removed, but connection status could not be cleared." }, { status: 503 });
  return NextResponse.json({ success: true });
}
