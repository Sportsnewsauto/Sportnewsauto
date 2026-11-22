import { NextResponse, type NextRequest } from "next/server";
import {
  completeVerifiedFlutterwaveCardPayment,
  completeVerifiedFlutterwavePayment,
} from "@/lib/server/flutterwave";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function subscriptionRedirect(request: NextRequest, result: "success" | "pending" | "cancelled") {
  const appUrl = (process.env.APP_BASE_URL || new URL(request.url).origin).replace(/\/$/, "");
  const target = new URL("/dashboard/subscription", appUrl);
  target.searchParams.set("payment", result);
  target.searchParams.set("provider", "flutterwave");
  return NextResponse.redirect(target);
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const status = (params.get("status") || "").toLowerCase();
  const reference = params.get("reference") || params.get("tx_ref") || "";
  const chargeId = params.get("id") || params.get("charge_id") || params.get("transaction_id") || "";

  if (status === "failed" || status === "cancelled") {
    return subscriptionRedirect(request, "cancelled");
  }

  // Redirect parameters are never trusted as proof of payment. The helper
  // retrieves the charge from Flutterwave and checks its amount and reference.
  if (!reference || !chargeId) {
    return subscriptionRedirect(request, "pending");
  }

  try {
    const completed = reference.startsWith("pc")
      ? await completeVerifiedFlutterwaveCardPayment(reference, chargeId)
      : await completeVerifiedFlutterwavePayment(reference, chargeId);
    return subscriptionRedirect(request, completed ? "success" : "pending");
  } catch {
    return subscriptionRedirect(request, "pending");
  }
}
