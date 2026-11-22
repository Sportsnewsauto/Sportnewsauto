import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/server/supabase-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validCallbackToken(provided: string, expected: string) {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  const expected = process.env.MPESA_CALLBACK_TOKEN;
  if (!expected || !validCallbackToken(token, expected)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid callback payload." }, { status: 400 });
  }

  const body = payload.Body as Record<string, unknown> | undefined;
  const callback = body?.stkCallback as Record<string, unknown> | undefined;
  const checkoutId = typeof callback?.CheckoutRequestID === "string" ? callback.CheckoutRequestID : "";
  const resultCode = Number(callback?.ResultCode);
  if (!checkoutId || !Number.isInteger(resultCode)) {
    return NextResponse.json({ error: "The M-Pesa callback is incomplete." }, { status: 400 });
  }

  const admin = createAdminClient();
  if (resultCode !== 0) {
    const { error } = await admin.rpc("fail_mpesa_subscription", {
      p_checkout_request_id: checkoutId,
      p_result_code: resultCode,
      p_result_description: String(callback?.ResultDesc || "M-Pesa payment was not completed."),
      p_callback_payload: payload,
    });
    if (error) {
      return NextResponse.json({ error: "Could not record the M-Pesa result." }, { status: 503 });
    }
    return NextResponse.json({ ResultCode: 0, ResultDesc: "Accepted" });
  }

  const metadata = callback?.CallbackMetadata as { Item?: Array<{ Name?: string; Value?: string | number }> } | undefined;
  const items = Array.isArray(metadata?.Item) ? metadata.Item : [];
  const values = Object.fromEntries(items.map(item => [String(item.Name || ""), item.Value]));
  const amount = Number(values.Amount);
  const receipt = String(values.MpesaReceiptNumber || "");
  const phone = String(values.PhoneNumber || "");

  if (!Number.isFinite(amount) || !receipt || !/^254[17]\\d{8}$/.test(phone)) {
    return NextResponse.json({ error: "The successful M-Pesa callback is missing verified payment details." }, { status: 400 });
  }

  const { error } = await admin.rpc("complete_mpesa_subscription", {
    p_checkout_request_id: checkoutId,
    p_amount: Math.round(amount),
    p_phone_number: phone,
    p_receipt: receipt,
    p_callback_payload: payload,
  });

  if (error) {
    // Return a retryable failure: a repeated callback is safe because the
    // database RPC is idempotent once the payment has been marked paid.
    return NextResponse.json({ error: "Could not verify and activate the Podcasti subscription." }, { status: 503 });
  }

  return NextResponse.json({ ResultCode: 0, ResultDesc: "Accepted" });
}
