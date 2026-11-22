import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { completeVerifiedFlutterwavePayment } from "@/lib/server/flutterwave";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeEqual(provided: string, expected: string) {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function POST(request: NextRequest) {
  const expectedHash = process.env.FLUTTERWAVE_WEBHOOK_HASH?.trim();
  const providedHash = request.headers.get("verif-hash") || "";
  if (!expectedHash || !providedHash || !safeEqual(providedHash, expectedHash)) {
    return NextResponse.json({ error: "Unauthorized webhook." }, { status: 401 });
  }

  let payload: {
    event?: unknown;
    data?: { id?: string | number; tx_ref?: string; status?: string };
  };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid webhook payload." }, { status: 400 });
  }

  if (payload.event !== "charge.completed") {
    return NextResponse.json({ received: true });
  }

  const transactionId = payload.data?.id === undefined ? "" : String(payload.data.id);
  const txRef = typeof payload.data?.tx_ref === "string" ? payload.data.tx_ref : "";
  if (!transactionId || !txRef) {
    return NextResponse.json({ error: "The Flutterwave webhook is missing its transaction reference." }, { status: 400 });
  }

  if (payload.data?.status !== "successful") {
    return NextResponse.json({ received: true });
  }

  try {
    const completed = await completeVerifiedFlutterwavePayment(txRef, transactionId);
    if (!completed) {
      return NextResponse.json({ error: "The Flutterwave transaction could not yet be verified." }, { status: 503 });
    }
    return NextResponse.json({ received: true });
  } catch {
    return NextResponse.json({ error: "Could not process the verified Flutterwave transaction." }, { status: 503 });
  }
}
