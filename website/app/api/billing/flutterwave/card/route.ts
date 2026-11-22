import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/server/supabase-admin";
import {
  completeVerifiedFlutterwaveCardV4Payment,
  flutterwaveV4Request,
  isFlutterwaveConfigured,
} from "@/lib/server/flutterwave";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DataWithId = { id?: string };
type OrchestratorCharge = {
  id?: string;
  reference?: string;
  status?: string;
  next_action?: {
    type?: string;
    redirect_url?: { url?: string };
  };
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

function validFlutterwaveRedirect(value: unknown): string | null {
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
      error: "Flutterwave V4 card checkout is not configured. Check the V4 Client ID, Client Secret and webhook hash in Cloudflare.",
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

  // "oc" marks V4 Orchestrator card payments. Existing V4 M-Pesa references
  // continue to use the "po" prefix and their existing verification route.
  const reference = `oc${randomUUID().replace(/-/g, "")}`;
  const { error: insertError } = await admin.from("billing_payments")
    .insert({
      owner_id: user.id,
      plan_interval: interval,
      amount_ksh: amount,
      phone_number: null,
      payment_provider: "flutterwave",
      tx_ref: reference,
      status: "pending",
      result_description: "Flutterwave V4 hosted card checkout awaiting payment.",
    });

  if (insertError) {
    return NextResponse.json({ error: "Could not create the secure payment record. Please try again." }, { status: 503 });
  }

  const appUrl = (process.env.APP_BASE_URL || new URL(request.url).origin).replace(/\/$/, "");
  if (!appUrl.startsWith("https://")) {
    await markCardPaymentFailed(admin, reference, "The configured payment callback URL must use HTTPS.");
    return NextResponse.json({ error: "The payment callback URL must be HTTPS. Check APP_BASE_URL in Cloudflare." }, { status: 503 });
  }

  let chargeCreated = false;
  try {
    const customerResult = await flutterwaveV4Request<DataWithId>("/customers", {
      method: "POST",
      idempotencyKey: `podcasti-customer-${user.id.replace(/-/g, "")}`,
      body: { email: user.email },
    });
    const customerId = customerResult.data?.id;
    if (customerResult.status !== "success" || !customerId) {
      throw new Error("Flutterwave could not create the customer record.");
    }

    const chargeResult = await flutterwaveV4Request<OrchestratorCharge>("/orchestration/direct-charges", {
      method: "POST",
      idempotencyKey: `${reference}-charge`,
      body: {
        amount,
        currency: "KES",
        reference,
        customer: { email: user.email },
        payment_method: {
          card: {
            type: "card",
            customer_id: customerId,
          },
        },
        redirect_url: `${appUrl}/api/billing/flutterwave/callback`,
        description: interval === "monthly" ? "Podcasti monthly subscription" : "Podcasti yearly subscription",
        meta: {
          product: "Podcasti subscription",
          plan_interval: interval,
          payment_channel: "hosted_card_v4",
        },
      },
    });

    const charge = chargeResult.data;
    if (
      chargeResult.status !== "success" ||
      !charge?.id ||
      (charge.reference && charge.reference !== reference)
    ) {
      throw new Error("Flutterwave did not return a valid card charge.");
    }
    chargeCreated = true;

    const { error: saveChargeError } = await admin.from("billing_payments")
      .update({
        flutterwave_transaction_id: charge.id,
        result_description: "Flutterwave V4 hosted card checkout awaiting payment.",
        updated_at: new Date().toISOString(),
      })
      .eq("tx_ref", reference)
      .eq("status", "pending");

    if (saveChargeError) {
      throw new Error("Flutterwave started the card charge, but Podcasti could not save its confirmation reference. Contact support before retrying.");
    }

    if (String(charge.status).toLowerCase() === "succeeded") {
      const completed = await completeVerifiedFlutterwaveCardV4Payment(reference, charge.id);
      if (completed) {
        return NextResponse.json({
          success: true,
          message: "Flutterwave confirmed your card payment. Your Podcasti subscription is active.",
        }, { headers: { "Cache-Control": "no-store" } });
      }
    }

    const checkoutUrl = validFlutterwaveRedirect(charge.next_action?.redirect_url?.url);
    if (!checkoutUrl) {
      throw new Error("Flutterwave did not return its secure card payment page. The charge may still be pending; contact support before retrying.");
    }

    return NextResponse.json({
      success: true,
      checkout_url: checkoutUrl,
      message: "Opening Flutterwave's secure Visa and Mastercard payment page.",
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    const diagnostic = cause instanceof Error ? cause.message : "Unknown provider error";
    console.error("[billing/flutterwave-card] V4 Orchestrator checkout failed", {
      reference,
      diagnostic,
    });
    if (!chargeCreated) {
      await markCardPaymentFailed(admin, reference, "Flutterwave V4 could not start the card checkout.");
    }
    return NextResponse.json({
      error: diagnostic || "Flutterwave could not start the card checkout. Please try again later.",
    }, { status: 502 });
  }
}
