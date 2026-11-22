import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/server/supabase-admin";
import {
  completeVerifiedFlutterwavePayment,
  flutterwaveV4Request,
  getKenyanMpesaNetwork,
  isFlutterwaveConfigured,
} from "@/lib/server/flutterwave";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeKenyanPhone(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const digits = value.replace(/[\s()+-]/g, "");
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  return null;
}

async function markPaymentFailed(admin: ReturnType<typeof createAdminClient>, reference: string, message: string) {
  await admin.from("billing_payments")
    .update({ status: "failed", result_description: message.slice(0, 500), updated_at: new Date().toISOString() })
    .eq("tx_ref", reference)
    .eq("status", "pending");
}

type DataWithId = { id?: string };
type ChargeData = {
  id?: string;
  reference?: string;
  status?: string;
  next_action?: {
    payment_instruction?: { note?: string };
    redirect_url?: { url?: string };
  };
};

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
      error: "Flutterwave V4 is not fully configured. Add the live Client ID, Client Secret and webhook hash in Cloudflare.",
    }, { status: 503 });
  }
  if (!(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)) {
    return NextResponse.json({ error: "Secure payment records are not configured. Contact the Podcasti administrator." }, { status: 503 });
  }

  let input: { interval?: unknown; phone?: unknown };
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "Choose a subscription plan and enter your M-Pesa phone number." }, { status: 400 });
  }

  const interval = input.interval === "yearly" ? "yearly" : input.interval === "monthly" ? "monthly" : null;
  const phone = normalizeKenyanPhone(input.phone);
  if (!interval || !phone) {
    return NextResponse.json({ error: "Choose Monthly or Yearly and enter a valid Kenyan M-Pesa phone number." }, { status: 400 });
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

  // V4 references must be 6–42 characters and contain only letters, numbers or hyphens.
  const reference = `po${randomUUID().replace(/-/g, "")}`;
  const { error: insertError } = await admin.from("billing_payments")
    .insert({
      owner_id: user.id,
      plan_interval: interval,
      amount_ksh: amount,
      phone_number: phone,
      payment_provider: "flutterwave",
      tx_ref: reference,
      status: "pending",
    });

  if (insertError) {
    return NextResponse.json({ error: "Could not create the secure payment record. Please try again." }, { status: 503 });
  }

  const appUrl = (process.env.APP_BASE_URL || new URL(request.url).origin).replace(/\/$/, "");
  if (!appUrl.startsWith("https://")) {
    await markPaymentFailed(admin, reference, "The configured payment callback URL must use HTTPS.");
    return NextResponse.json({ error: "The payment callback URL must be HTTPS. Check APP_BASE_URL in Cloudflare." }, { status: 503 });
  }

  let chargeCreated = false;
  let paymentStage = "checking Flutterwave authentication and the Kenya M-Pesa network";
  try {
    const network = await getKenyanMpesaNetwork();

    paymentStage = "creating your Flutterwave customer record";
    const customerResult = await flutterwaveV4Request<DataWithId>("/customers", {
      method: "POST",
      idempotencyKey: `podcasti-customer-${user.id.replace(/-/g, "")}`,
      body: { email: user.email },
    });
    const customerId = customerResult.data?.id;
    if (customerResult.status !== "success" || !customerId) {
      throw new Error("Flutterwave could not create the customer record.");
    }

    paymentStage = "setting up your M-Pesa phone payment method";
    const paymentMethodResult = await flutterwaveV4Request<DataWithId>("/payment-methods", {
      method: "POST",
      idempotencyKey: `${reference}-pm`,
      body: {
        type: "mobile_money",
        mobile_money: {
          country_code: "254",
          network,
          phone_number: phone.slice(3),
        },
      },
    });
    const paymentMethodId = paymentMethodResult.data?.id;
    if (paymentMethodResult.status !== "success" || !paymentMethodId) {
      throw new Error("Flutterwave could not prepare the M-Pesa payment method.");
    }

    paymentStage = "starting the M-Pesa charge";
    const chargeResult = await flutterwaveV4Request<ChargeData>("/charges", {
      method: "POST",
      idempotencyKey: `${reference}-charge`,
      body: {
        reference,
        currency: "KES",
        amount,
        customer_id: customerId,
        payment_method_id: paymentMethodId,
        redirect_url: `${appUrl}/api/billing/flutterwave/callback`,
        meta: {
          product: "Podcasti subscription",
          plan_interval: interval,
        },
      },
    });

    const charge = chargeResult.data;
    if (
      chargeResult.status !== "success" ||
      !charge?.id ||
      (charge.reference && charge.reference !== reference)
    ) {
      throw new Error("Flutterwave did not return a valid charge.");
    }
    chargeCreated = true;

    const instruction = charge.next_action?.payment_instruction?.note
      || "Flutterwave has sent an M-Pesa payment request to your phone. Check your phone and approve it to complete the payment.";
    const { error: saveChargeError } = await admin.from("billing_payments")
      .update({
        flutterwave_transaction_id: charge.id,
        result_description: instruction.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq("tx_ref", reference)
      .eq("status", "pending");

    if (saveChargeError) {
      throw new Error("The payment was started, but Podcasti could not save its confirmation reference.");
    }

    if (String(charge.status).toLowerCase() === "succeeded") {
      const completed = await completeVerifiedFlutterwavePayment(reference, charge.id);
      return NextResponse.json({
        success: true,
        message: completed ? "Flutterwave confirmed your payment. Your subscription is active." : instruction,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    return NextResponse.json({
      success: true,
      message: instruction,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    // Never log request bodies, access tokens, customer phone numbers or secrets.
    // The helper sanitizes customer identifiers from provider messages.
    const diagnostic = cause instanceof Error ? cause.message : "Unknown provider error";
    console.error("[billing/flutterwave] Payment initiation failed", {
      stage: paymentStage,
      diagnostic,
      reference,
    });

    // Do not mark a charge failed after Flutterwave created it. If saving the
    // local reference transiently fails, the signed webhook/callback can still
    // verify it by the unique merchant reference.
    if (!chargeCreated) {
      await markPaymentFailed(admin, reference, `Flutterwave failed while ${paymentStage}.`);
    }
    return NextResponse.json({
      error: `Flutterwave could not complete ${paymentStage}. ${diagnostic}`,
    }, { status: 502 });
  }
}
