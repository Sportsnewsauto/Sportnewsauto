import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, isMpesaConfigured, mpesaBaseUrl } from "@/lib/server/supabase-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeKenyanPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/[\s()+-]/g, "");
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  return null;
}

function darajaTimestamp() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}${values.hour}${values.minute}${values.second}`;
}

async function markPaymentFailed(admin: ReturnType<typeof createAdminClient>, paymentId: string, message: string) {
  await admin.from("billing_payments")
    .update({ status: "failed", result_description: message.slice(0, 500), updated_at: new Date().toISOString() })
    .eq("id", paymentId)
    .eq("status", "pending");
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return NextResponse.json({ error: "Cross-site requests are not allowed." }, { status: 403 });
  }

  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  }

  if (!isMpesaConfigured() || !(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)) {
    return NextResponse.json({
      error: "M-Pesa checkout is not configured yet. Podcasti must be connected to a Safaricom Daraja app before customers can pay.",
    }, { status: 503 });
  }

  let input: { interval?: unknown; phone?: unknown };
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "Enter your M-Pesa phone number and choose a subscription." }, { status: 400 });
  }

  const interval = input.interval === "yearly" ? "yearly" : input.interval === "monthly" ? "monthly" : null;
  const phone = normalizeKenyanPhone(input.phone);
  if (!interval || !phone) {
    return NextResponse.json({ error: "Choose Monthly or Yearly and enter a valid Kenyan M-Pesa number, for example 0712345678." }, { status: 400 });
  }

  const amount = interval === "monthly" ? 3000 : 15000;
  const { data: workspace, error: workspaceError } = await supabase
    .from("workspaces")
    .select("plan,subscription_status,subscription_expires_at")
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
      error: "You already have an M-Pesa payment waiting for confirmation. Check your phone, then refresh your Subscription page before starting another payment.",
    }, { status: 409 });
  }

  const { data: payment, error: insertError } = await admin.from("billing_payments")
    .insert({
      owner_id: user.id,
      plan_interval: interval,
      amount_ksh: amount,
      phone_number: phone,
      status: "pending",
    })
    .select("id")
    .single();

  if (insertError || !payment) {
    return NextResponse.json({ error: "Could not create the secure payment record. Please try again." }, { status: 503 });
  }

  const baseUrl = mpesaBaseUrl();
  const timestamp = darajaTimestamp();
  const shortcode = process.env.MPESA_SHORTCODE!;
  const passkey = process.env.MPESA_PASSKEY!;
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");
  const callbackToken = process.env.MPESA_CALLBACK_TOKEN!;
  const appUrl = (process.env.APP_BASE_URL || new URL(request.url).origin).replace(/\/$/, "");
  if (!appUrl.startsWith("https://")) {
    await markPaymentFailed(admin, payment.id, "The configured callback base URL must use HTTPS.");
    return NextResponse.json({ error: "The M-Pesa callback URL must be a public HTTPS address. Set APP_BASE_URL to the live Podcasti website URL." }, { status: 503 });
  }
  const callbackUrl = `${appUrl}/api/billing/mpesa/callback/${encodeURIComponent(callbackToken)}`;

  try {
    const basic = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString("base64");
    const authResponse = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${basic}` },
      cache: "no-store",
    });
    const auth = await authResponse.json() as { access_token?: string };
    if (!authResponse.ok || !auth.access_token) {
      throw new Error("Safaricom did not issue a Daraja access token. Check the Consumer Key and Consumer Secret.");
    }

    const response = await fetch(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: process.env.MPESA_TRANSACTION_TYPE || "CustomerPayBillOnline",
        Amount: amount,
        PartyA: phone,
        PartyB: shortcode,
        PhoneNumber: phone,
        CallBackURL: callbackUrl,
        AccountReference: "PODCASTI",
        TransactionDesc: `Podcasti ${interval} subscription`,
      }),
      cache: "no-store",
    });
    const result = await response.json() as {
      ResponseCode?: string;
      ResponseDescription?: string;
      CustomerMessage?: string;
      CheckoutRequestID?: string;
      MerchantRequestID?: string;
    };

    if (!response.ok || result.ResponseCode !== "0" || !result.CheckoutRequestID) {
      const message = result.ResponseDescription || "Safaricom did not accept the M-Pesa request.";
      await markPaymentFailed(admin, payment.id, message);
      return NextResponse.json({ error: message }, { status: 502 });
    }

    const { error: updateError } = await admin.from("billing_payments")
      .update({
        checkout_request_id: result.CheckoutRequestID,
        merchant_request_id: result.MerchantRequestID || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", payment.id);
    if (updateError) {
      // Payment prompt might already be on the handset. Do not initiate a second one.
      return NextResponse.json({
        error: "M-Pesa accepted the request, but Podcasti could not save its checkout reference. Contact support before trying again.",
      }, { status: 503 });
    }

    return NextResponse.json({
      success: true,
      message: result.CustomerMessage || "Check your phone and enter your M-Pesa PIN to approve the payment. Your plan will activate only after Safaricom confirms payment.",
      payment_id: payment.id,
      checkout_request_id: result.CheckoutRequestID,
    }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Could not start M-Pesa checkout.";
    await markPaymentFailed(admin, payment.id, message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
