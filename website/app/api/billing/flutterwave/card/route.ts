import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/server/supabase-admin";
import { isFlutterwaveConfigured } from "@/lib/server/flutterwave";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StandardCheckoutResponse = {
  status?: string;
  message?: string;
  data?: { link?: string };
};

async function markCardPaymentFailed(
  admin: ReturnType<typeof createAdminClient>,
  reference: string,
  message: string,
) {
  await admin.from("billing_payments")
    .update({
      status: "failed",
      result_description: message.slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq("tx_ref", reference)
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

  const secretKey = process.env.FLUTTERWAVE_V3_SECRET_KEY?.trim();
  if (!secretKey || !process.env.FLUTTERWAVE_WEBHOOK_HASH?.trim() || !isFlutterwaveConfigured()) {
    return NextResponse.json({
      error: "Flutterwave hosted card checkout is not configured. The administrator must add the V3 Live Secret Key in Cloudflare.",
    }, { status: 503 });
  }
  if (!(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)) {
    return NextResponse.json({ error: "Secure payment records are not configured. Contact the Podcasti administrator." }, { status: 503 });
  }

  let input: { interval?: unknown };
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "Choose a subscription plan." }, { status: 400 });
  }

  const interval = input.interval === "yearly" ? "yearly" : input.interval === "monthly" ? "monthly" : null;
  if (!interval) {
    return NextResponse.json({ error: "Choose Monthly or Yearly." }, { status: 400 });
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

  // "pc" identifies hosted V3 card references so callbacks and webhooks use
  // V3 transaction verification. Existing V4 M-Pesa references remain "po".
  const reference = `pc${randomUUID().replace(/-/g, "")}`;
  const { error: insertError } = await admin.from("billing_payments")
    .insert({
      owner_id: user.id,
      plan_interval: interval,
      amount_ksh: amount,
      phone_number: null,
      payment_provider: "flutterwave",
      tx_ref: reference,
      status: "pending",
      result_description: "Flutterwave hosted card checkout awaiting payment.",
    });

  if (insertError) {
    return NextResponse.json({ error: "Could not create the secure payment record. Please try again." }, { status: 503 });
  }

  const appUrl = (process.env.APP_BASE_URL || new URL(request.url).origin).replace(/\/$/, "");
  if (!appUrl.startsWith("https://")) {
    await markCardPaymentFailed(admin, reference, "The configured payment callback URL must use HTTPS.");
    return NextResponse.json({ error: "The payment callback URL must be HTTPS. Check APP_BASE_URL in Cloudflare." }, { status: 503 });
  }

  try {
    const response = await fetch("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        tx_ref: reference,
        amount,
        currency: "KES",
        redirect_url: `${appUrl}/api/billing/flutterwave/callback`,
        payment_options: "card",
        customer: { email: user.email },
        customizations: {
          title: "Podcasti Subscription",
          description: interval === "monthly" ? "Monthly Podcasti subscription" : "Yearly Podcasti subscription",
        },
        meta: {
          product: "Podcasti subscription",
          plan_interval: interval,
          payment_channel: "hosted_card",
        },
        session_duration: 30,
        max_retry_attempt: 3,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });

    const result = await response.json().catch(() => ({})) as StandardCheckoutResponse;
    const link = result.data?.link;
    let checkoutUrl: URL | null = null;
    try {
      if (typeof link === "string") checkoutUrl = new URL(link);
    } catch {
      checkoutUrl = null;
    }

    if (!response.ok || result.status !== "success" || !checkoutUrl ||
        checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "checkout.flutterwave.com") {
      await markCardPaymentFailed(admin, reference, "Flutterwave could not create the hosted card checkout link.");
      return NextResponse.json({
        error: "Flutterwave could not create the hosted card checkout link. Confirm that the V3 Live Secret Key is correct and card payments are enabled for your merchant account.",
      }, { status: 502 });
    }

    return NextResponse.json({
      success: true,
      checkout_url: checkoutUrl.toString(),
      message: "Opening Flutterwave's secure card checkout.",
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    await markCardPaymentFailed(admin, reference, "Flutterwave hosted card checkout request failed.");
    return NextResponse.json({
      error: "Could not connect to Flutterwave hosted card checkout. Please try again later.",
    }, { status: 502 });
  }
}
