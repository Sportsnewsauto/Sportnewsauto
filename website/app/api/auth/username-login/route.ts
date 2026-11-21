import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  let body: { username?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const configuredUsername = process.env.ADMIN_LOGIN_USERNAME;
  const adminEmail = process.env.ADMIN_LOGIN_EMAIL;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!configuredUsername || !adminEmail || !url || !key) {
    return NextResponse.json({ error: "Owner login is not configured yet." }, { status: 503 });
  }

  if (!username || !password || username.toLowerCase() !== configuredUsername.toLowerCase()) {
    return NextResponse.json({ error: "Invalid username or password." }, { status: 401 });
  }

  const response = NextResponse.json({ success: true });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const { error } = await supabase.auth.signInWithPassword({ email: adminEmail, password });
  if (error) {
    return NextResponse.json({ error: "Invalid username or password." }, { status: 401 });
  }

  return response;
}
