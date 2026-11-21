import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { encryptCredential } from "@/lib/server/credential-vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const providers = ["spreaker", "groq", "gemini"] as const;
type Provider = typeof providers[number];

function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && providers.includes(value as Provider);
}

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

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
  const input = body as { provider?: unknown; secret?: unknown };
  if (!isProvider(input?.provider) || typeof input.secret !== "string") {
    return NextResponse.json({ error: "Choose a provider and enter its API credential." }, { status: 400 });
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

  const { error: saveError } = await supabase.from("integration_credentials").upsert({
    owner_id: user.id,
    provider: input.provider,
    ...encrypted,
    updated_at: new Date().toISOString(),
  }, { onConflict: "owner_id,provider" });
  if (saveError) return NextResponse.json({ error: "Could not store this credential. Apply Supabase migration 0002 and try again." }, { status: 503 });

  const { error: statusError } = await supabase.from("integration_connections").upsert({
    owner_id: user.id,
    provider: input.provider,
    status: "saved_unverified",
    masked_suffix: secret.slice(-4),
    updated_at: new Date().toISOString(),
  }, { onConflict: "owner_id,provider" });
  if (statusError) return NextResponse.json({ error: "Credential encrypted, but its connection status could not be saved." }, { status: 503 });

  return NextResponse.json({ success: true, message: "Credential encrypted and saved. Provider verification is not connected yet." }, { status: 201, headers: { "Cache-Control": "no-store" } });
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

  const { error } = await supabase.from("integration_credentials").delete().eq("owner_id", user.id).eq("provider", provider);
  if (error) return NextResponse.json({ error: "Could not remove the saved credential." }, { status: 503 });
  const { error: statusError } = await supabase.from("integration_connections").delete().eq("owner_id", user.id).eq("provider", provider);
  if (statusError) return NextResponse.json({ error: "Credential removed, but connection status could not be cleared." }, { status: 503 });
  return NextResponse.json({ success: true });
}
