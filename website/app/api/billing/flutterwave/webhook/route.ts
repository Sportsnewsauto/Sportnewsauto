import { NextResponse, type NextRequest } from "next/server";
import {
  completeVerifiedFlutterwavePayment,
  verifyFlutterwaveWebhookHash,
} from "@/lib/server/flutterwave";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type FlutterwaveWebhookPayload = {
  event?: string;
  data?: {
    id?: string | number;
    tx_ref?: string;
    status?: string;
  };
};

export async function POST(request: NextRequest) {
  const signature = request.headers.get("verif-hash") || "";
  if (!verifyFlutterwaveWebhookHash(signature)) {
    return NextResponse.json({ error: "Unauthorized Flutterwave webhook." }, { status: 401 });
  }

  let payload: FlutterwaveWebhookPayload;
  try {
    payload = await request.json() as FlutterwaveWebhookPayload;
  } catch {
    return NextResponse.json({ error: "Invalid webhook payload." }, { status: 400 });
  }

  if (payload.event !== "charge.completed" ||
      String(payload.data?.status || "").toLowerCase() !== "successful") {
    return NextResponse.json({ received: true });
  }

  const transactionId = payload.data?.id === undefined ? "" : String(payload.data.id);
  const reference = typeof payload.data?.tx_ref === "string" ? payload.data.tx_ref : "";
  if (!transactionId || !reference) {
    return NextResponse.json({ error: "The Flutterwave webhook is missing its transaction reference." }, { status: 400 });
  }

  try {
    const completed = await completeVerifiedFlutterwavePayment(reference, transactionId);
    if (!completed) {
      return NextResponse.json({ error: "The Flutterwave transaction could not yet be verified." }, { status: 503 });
    }
    return NextResponse.json({ received: true });
  } catch {
    return NextResponse.json({ error: "Could not verify the Flutterwave V3 transaction." }, { status: 503 });
  }
}
