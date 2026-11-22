import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/server/supabase-admin";
import { flutterwaveV3Request, isFlutterwaveConfigured } from "@/lib/server/flutterwave";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type HostedCheckoutData = { link?: string };

function validFlutterwaveCheckout(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const allowedHost = url.hostname.endsWith(".flutterwave.com") ||
      url.hostname.endsWith(".flutterwave.cloud") ||
      url.hostname === "flutterwave.com";
    return url.protocol === "https:" && allowedHost ? url.toString() : null;
  } catch {
    return null;
  }
}

async function markPaymentFailed(
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

  if (!isFlutterwaveConfigured()) {
    return NextResponse.json({
      error: "Flutterwave V3 is not fully configured. Add the V3 Secret Key and webhook hash in Cloudflare Runtime variables and secrets.",
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

  const reference = "fw" + randomUUID().replace(/-/g, "");
  const { error: insertError } = await admin.from("billing_payments")
    .insert({
      owner_id: user.id,
      plan_interval: interval,
      amount_ksh: amount,
      phone_number: null,
      payment_provider: "flutterwave",
      tx_ref: reference,
      status: "pending",
      result_description: "Flutterwave hosted checkout awaiting card or M-Pesa payment.",
    });

  if (insertError) {
    return NextResponse.json({ error: "Could not create the secure payment record. Please try again." }, { status: 503 });
  }

  const appUrl = (process.env.APP_BASE_URL || new URL(request.url).origin).replace(/\/$/, "");
  if (!appUrl.startsWith("https://")) {
    await markPaymentFailed(admin, reference, "The configured payment callback URL must use HTTPS.");
    return NextResponse.json({ error: "The payment callback URL must use HTTPS. Check APP_BASE_URL in Cloudflare." }, { status: 503 });
  }

  let checkoutCreated = false;
  try {
    const result = await flutterwaveV3Request<HostedCheckoutData>("/payments", {
      method: "POST",
      body: {
        tx_ref: reference,
        amount,
        currency: "KES",
        redirect_url: appUrl + "/api/billing/flutterwave/callback",
        customer: { email: user.email },
        payment_options: "card, mpesa",
        customizations: {
          title: "Podcasti",
          description: interval === "monthly"
            ? "Podcasti monthly subscription"
            : "Podcasti yearly subscription",
        },
      },
    });

    const providerMessage = typeof result.message === "string"
      ? result.message.replace(/[\\r\\n\\t]+/g, " ").slice(0, 180)
      : "";
    const dataKeys = result.data && typeof result.data === "object"
      ? Object.keys(result.data as Record<string, unknown>).slice(0, 12)
      : [];

    if (result.status !== "success") {
      throw new Error(
        "Flutterwave checkout returned status " + String(result.status || "missing") +
        (providerMessage ? ": " + providerMessage : "."),
      );
    }

    const rawLink = result.data?.link;
    const checkoutUrl = validFlutterwaveCheckout(rawLink);
    if (!checkoutUrl) {
      const detail = !rawLink
        ? "Flutterwave returned no data.link (data fields: " + (dataKeys.join(", ") || "none") + ")."
        : "Flutterwave returned a checkout URL on an unsupported host.";
      throw new Error(
        detail + (providerMessage ? " Provider message: " + providerMessage : ""),
      );
    }
    checkoutCreated = true;

    return NextResponse.json({
      success: true,
      checkout_url: checkoutUrl,
      message: "Opening Flutterwave's secure checkout. Choose Visa, Mastercard or M-Pesa on the payment page.",
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    const diagnostic = cause instanceof Error ? cause.message : "Unknown provider error";
    console.error("[billing/flutterwave] V3 hosted checkout creation failed", {
      reference,
      diagnostic,
    });
    if (!checkoutCreated) {
      await markPaymentFailed(admin, reference, "Flutterwave V3 could not create the hosted checkout.");
    }
    return NextResponse.json({
      error: diagnostic || "Flutterwave could not start checkout. Please try again later.",
    }, { status: 502 });
  }
}
