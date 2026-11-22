import { NextResponse, type NextRequest } from "next/server";
import { completeVerifiedFlutterwavePayment } from "@/lib/server/flutterwave";

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
  const status = params.get("status");
  const txRef = params.get("tx_ref") || "";
  const transactionId = params.get("transaction_id") || "";

  if (status !== "successful" || !txRef || !transactionId) {
    return subscriptionRedirect(request, "cancelled");
  }

  try {
    const completed = await completeVerifiedFlutterwavePayment(txRef, transactionId);
    return subscriptionRedirect(request, completed ? "success" : "pending");
  } catch {
    return subscriptionRedirect(request, "pending");
  }
}
