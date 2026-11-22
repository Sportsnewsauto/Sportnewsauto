import { NextResponse, type NextRequest } from "next/server";
import {
  completeVerifiedFlutterwavePayment,
  verifyFlutterwaveV4WebhookSignature,
} from "@/lib/server/flutterwave";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type V4WebhookPayload = {
  type?: string;
  event?: string;
  data?: {
    id?: string | number;
    reference?: string;
    tx_ref?: string;
    status?: string;
  };
};

export async function POST(request: NextRequest) {
  // Read the original bytes before parsing JSON; the V4 HMAC is calculated
  // over the exact raw request body.
  const rawBody = await request.text();
  const signature = request.headers.get("flutterwave-signature") || "";
  if (!verifyFlutterwaveV4WebhookSignature(rawBody, signature)) {
    return NextResponse.json({ error: "Unauthorized Flutterwave webhook." }, { status: 401 });
  }

  let payload: V4WebhookPayload;
  try {
    payload = JSON.parse(rawBody) as V4WebhookPayload;
  } catch {
    return NextResponse.json({ error: "Invalid webhook payload." }, { status: 400 });
  }

  if ((payload.type || payload.event) !== "charge.completed") {
    return NextResponse.json({ received: true });
  }

  // V4 reports successful charges as "succeeded" and uses "reference".
  if (String(payload.data?.status || "").toLowerCase() !== "succeeded") {
    return NextResponse.json({ received: true });
  }

  const chargeId = payload.data?.id === undefined ? "" : String(payload.data.id);
  const reference = typeof payload.data?.reference === "string"
    ? payload.data.reference
    : typeof payload.data?.tx_ref === "string" ? payload.data.tx_ref : "";

  if (!chargeId || !reference) {
    return NextResponse.json({ error: "The Flutterwave webhook is missing its charge reference." }, { status: 400 });
  }

  try {
    const completed = await completeVerifiedFlutterwavePayment(reference, chargeId);
    if (!completed) {
      return NextResponse.json({ error: "The Flutterwave charge could not yet be verified." }, { status: 503 });
    }
    return NextResponse.json({ received: true });
  } catch {
    return NextResponse.json({ error: "Could not verify the Flutterwave V4 charge." }, { status: 503 });
  }
}
