import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return NextResponse.redirect(new URL("/login", request.url));

  const clientId = process.env.SPREAKER_CLIENT_ID;
  const clientSecret = process.env.SPREAKER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(new URL("/dashboard/api-connections?spreaker=app-not-configured", request.url));
  }

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
