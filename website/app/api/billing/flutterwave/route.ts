import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/server/supabase-admin";
import { isFlutterwaveConfigured } from "@/lib/server/flutterwave";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeKenyanPhone(value: unknown): string | null | undefined {
  if (typeof value !== "string" || !value.trim()) return null;
  const digits = value.replace(/[\s()+-]/g, "");
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  return undefined;
}

async function markPaymentFailed(admin: ReturnType<typeof createAdminClient>, txRef: string, message: string) {
  await admin.from("billing_payments")
    .update({ status: "failed", result_description: message.slice(0, 500), updated_at: new Date().toISOString() })
    .eq("tx_ref", txRef)
    .eq("status", "pending");
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return NextResponse.json({ error: "Cross-site requests are not allowed." }, { status: 403 });
  }

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user || !user.email) {
    return NextResponse.json({ error: "Please sign in again before starting payment." }, { status: 401 });
  }

  if (!isFlutterwaveConfigured()) {
    return NextResponse.json({ error: "Flutterwave checkout is not configured yet. Add the server-side Flutterwave secret key." }, { status: 503 });
  }
  if (!(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)) {
    return NextResponse.json({ error: "Secure payment records are not configured. Contact the Podcasti administrator." }, { status: 503 });
  }

  let input: { interval?: unknown; phone?: unknown };
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "Choose a subscription plan and try again." }, { status: 400 });
  }

  const interval = input.interval === "yearly" ? "yearly" : input.interval === "monthly" ? "monthly" : null;
  const phone = normalizeKenyanPhone(input.phone);
  if (!interval || phone === undefined) {
    return NextResponse.json({ error: "Choose Monthly or Yearly and enter a valid Kenyan phone number, or leave the phone number blank." }, { status: 400 });
  }

  const amount = interval === "monthly" ? 3000 : 15000;
  const { data: workspace, error: workspaceError } = await supabase
    .from("workspaces")
    .select("plan")
    .eq("owner_id", user.id)
    .maybeSingle();

  if (workspaceError || !workspace) {
    return NextResponse.json({ error: "Your Podcasti workspace could not be loaded." }, { status: 503 });
  }
  if (workspace.plan === "admin") {
    return NextResponse.json({ error: "The platform Admin workspace does not use customer billing." }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: pending } = await admin.from("billing_payments")
    .select("id,created_at")
    .eq("owner_id", user.id)
    .eq("status", "pending")
    .gte("created_at", new Date(Date.now() - 10 * 60 * 1000).toISOString())
    .limit(1)
    .maybeSingle();

  if (pending) {
    return NextResponse.json({
      error: "You already have a payment waiting for confirmation. Complete it or refresh your Subscription page before starting another payment.",
    }, { status: 409 });
  }

  const txRef = `podcasti_${randomUUID()}`;
  const { error: insertError } = await admin.from("billing_payments")
    .insert({
      owner_id: user.id,
      plan_interval: interval,
      amount_ksh: amount,
      phone_number: phone,
      payment_provider: "flutterwave",
      tx_ref: txRef,
      status: "pending",
    });

  if (insertError) {
    return NextResponse.json({ error: "Could not create the secure payment record. Please try again." }, { status: 503 });
  }

  const appUrl = (process.env.APP_BASE_URL || new URL(request.url).origin).replace(/\/$/, "");
  if (!appUrl.startsWith("https://")) {
    await markPaymentFailed(admin, txRef, "The configured payment callback URL must use HTTPS.");
    return NextResponse.json({ error: "The payment callback URL must be HTTPS. Check APP_BASE_URL in Cloudflare." }, { status: 503 });
  }

  try {
    const customer: Record<string, string> = { email: user.email };
    const displayName = typeof user.user_metadata?.full_name === "string"
      ? user.user_metadata.full_name
      : typeof user.user_metadata?.name === "string" ? user.user_metadata.name : "";
    if (displayName) customer.name = displayName;
    if (phone) customer.phone_number = phone;

    const response = await fetch("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY!.trim()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        tx_ref: txRef,
        amount,
        currency: "KES",
        redirect_url: `${appUrl}/api/billing/flutterwave/callback`,
        customer,
        payment_options: "card,mpesa",
        customizations: {
          title: "Podcasti subscription",
          description: `Podcasti ${interval} subscription`,
        },
        meta: {
          tx_ref: txRef,
          plan_interval: interval,
          payment_id: txRef,
        },
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });

    const result = await response.json() as {
      status?: string;
      message?: string;
      data?: { link?: string };
    };
    const checkoutLink = result.data?.link;
    let checkoutUrl: URL | null = null;
    try {
      if (checkoutLink) checkoutUrl = new URL(checkoutLink);
    } catch {
      checkoutUrl = null;
    }

    if (
      !response.ok ||
      result.status !== "success" ||
      !checkoutUrl ||
      checkoutUrl.protocol !== "https:" ||
      checkoutUrl.hostname !== "checkout.flutterwave.com"
    ) {
      await markPaymentFailed(admin, txRef, "Flutterwave did not return a valid hosted checkout link.");
      return NextResponse.json({ error: "Flutterwave could not start checkout. Check the gateway account and try again." }, { status: 502 });
    }

    return NextResponse.json({
      success: true,
      checkout_url: checkoutUrl.toString(),
      tx_ref: txRef,
    }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch {
    await markPaymentFailed(admin, txRef, "Could not contact Flutterwave to create checkout.");
    return NextResponse.json({ error: "Could not connect to Flutterwave. Please try again." }, { status: 502 });
  }
}
