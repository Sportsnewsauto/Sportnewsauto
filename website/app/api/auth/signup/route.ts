import { createHmac, hkdfSync, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import disposableEmailDomainData from "@/lib/server/disposable-email-domains.json";
import { createAdminClient } from "@/lib/server/supabase-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const disposableDomains = new Set(disposableEmailDomainData.domains);

function disposableDomainMatch(domain: string): boolean {
  const labels = domain.toLowerCase().split(".");
  for (let i = 0; i < labels.length - 1; i += 1) {
    if (disposableDomains.has(labels.slice(i).join("."))) return true;
  }
  return false;
}

function hashClientIp(ip: string): string {
  const encodedKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!encodedKey) throw new Error("Signup protection is not configured.");
  const masterKey = Buffer.from(encodedKey, "base64");
  if (masterKey.length !== 32) throw new Error("Signup protection is not configured.");

  // Derive a separate key for IP hashing; never store the raw address.
  const derivedKey = Buffer.from(hkdfSync(
    "sha256",
    masterKey,
    Buffer.from("podcasti-free-signup-v1"),
    Buffer.from("ip-address-hmac"),
    32,
  ));
  return createHmac("sha256", derivedKey).update(ip.toLowerCase()).digest("hex");
}

async function releaseUnusedClaim(
  admin: ReturnType<typeof createAdminClient>,
  claimToken: string,
) {
  await admin
    .from("free_signup_ip_claims")
    .delete()
    .eq("claim_token", claimToken)
    .is("owner_id", null);
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: "Cross-site requests are not allowed." }, { status: 403 });
  }

  let body: { email?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid signup request." }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const emailParts = email.split("@");
  if (
    emailParts.length !== 2 ||
    !emailParts[0] ||
    !emailParts[1] ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
  }

  const domain = domainToASCII(emailParts[1]);
  if (!domain || disposableDomainMatch(domain)) {
    return NextResponse.json({
      error: "Temporary or disposable email addresses cannot be used to create a Podcasti account. Please use a regular email address.",
    }, { status: 400 });
  }

  // Cloudflare sets this header at the edge. Do not trust user-supplied
  // X-Forwarded-For values for account eligibility.
  const clientIp = request.headers.get("cf-connecting-ip")?.trim();
  if (!clientIp || isIP(clientIp) === 0) {
    return NextResponse.json({
      error: "We could not verify your network address. Please reload the page and try again.",
    }, { status: 503 });
  }

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: "Signup is temporarily unavailable. Please try again later." }, { status: 503 });
  }

  const ipHash = (() => {
    try {
      return hashClientIp(clientIp);
    } catch {
      return null;
    }
  })();
  if (!ipHash) {
    return NextResponse.json({ error: "Signup protection is temporarily unavailable." }, { status: 503 });
  }

  const now = new Date();
  const claimToken = randomUUID();

  try {
    // Clear only abandoned, unclaimed reservations. Claimed IP hashes remain
    // permanently reserved, including after the associated user is deleted.
    const { error: cleanupError } = await admin
      .from("free_signup_ip_claims")
      .delete()
      .is("owner_id", null)
      .not("claim_token", "is", null)
      .lt("expires_at", now.toISOString());
    if (cleanupError) throw cleanupError;

    const { error: claimError } = await admin
      .from("free_signup_ip_claims")
      .insert({
        ip_hash: ipHash,
        claim_token: claimToken,
        expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
      });

    if (claimError) {
      if (claimError.code === "23505") {
        return NextResponse.json({
          error: "Only one Free account can be registered from a public IP address. Sign in to your existing account. People sharing the same public network also share this limit.",
        }, { status: 409 });
      }
      throw claimError;
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
    const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !publishableKey) throw new Error("Supabase Auth is not configured.");

    const authClient = createSupabaseClient(supabaseUrl, publishableKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
    const { data, error } = await authClient.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: new URL("/auth/callback", request.nextUrl.origin).toString(),
        data: { free_signup_claim_token: claimToken },
      },
    });

    if (error || !data.user) {
      await releaseUnusedClaim(admin, claimToken);
      return NextResponse.json({
        error: error?.message || "Could not create your account. Please try again.",
      }, { status: 400 });
    }

    // Existing-email signups can be returned as a deliberately empty identity
    // by Supabase. They must not consume the IP reservation.
    if (!data.session && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      await releaseUnusedClaim(admin, claimToken);
      return NextResponse.json({
        error: "An account with this email may already exist. Sign in or reset your password.",
      }, { status: 400 });
    }

    // Verify that the database trigger accepted and consumed this one-time
    // claim while creating the profile and workspace for the new Auth user.
    const { data: storedClaim, error: verifyError } = await admin
      .from("free_signup_ip_claims")
      .select("owner_id")
      .eq("ip_hash", ipHash)
      .maybeSingle();
    if (verifyError || storedClaim?.owner_id !== data.user.id) {
      await releaseUnusedClaim(admin, claimToken);
      return NextResponse.json({
        error: "Your account could not be securely initialized. Please try again.",
      }, { status: 503 });
    }

    return NextResponse.json({
      message: "Account created. Check your email for the confirmation link, then sign in.",
      session: data.session
        ? { access_token: data.session.access_token, refresh_token: data.session.refresh_token }
        : null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    await releaseUnusedClaim(admin, claimToken);
    return NextResponse.json({
      error: "Signup is temporarily unavailable. Please try again later.",
    }, { status: 503 });
  }
}
