import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { decryptCredential } from "@/lib/server/credential-vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return NextResponse.redirect(new URL("/login", request.url));

  const { data: stored, error: storedError } = await supabase.rpc("get_integration_credential", { p_provider: "spreaker" });
  const row = Array.isArray(stored) ? stored[0] : stored;
  if (storedError || !row) return NextResponse.redirect(new URL("/dashboard/api-connections?spreaker=app-credentials-missing", request.url));
  let app: { client_id?: string; client_secret?: string };
  try { app = JSON.parse(decryptCredential(row)); }
  catch { return NextResponse.redirect(new URL("/dashboard/api-connections?spreaker=app-credentials-missing", request.url)); }
  const clientId = app.client_id;
  const clientSecret = app.client_secret;
  if (!clientId || !clientSecret) return NextResponse.redirect(new URL("/dashboard/api-connections?spreaker=app-credentials-missing", request.url));

  const redirectUri = process.env.SPREAKER_REDIRECT_URI
    || new URL("/api/integrations/spreaker/callback", request.url).toString();
  const state = randomBytes(32).toString("hex");
  const authorize = new URL("https://www.spreaker.com/oauth2/authorize");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("scope", "basic");
  authorize.searchParams.set("redirect_uri", redirectUri);

  const response = NextResponse.redirect(authorize);
  response.cookies.set("spreaker_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/integrations/spreaker/callback",
    maxAge: 600,
  });
  return response;
}
