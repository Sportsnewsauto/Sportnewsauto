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
  const status = (params.get("status") || "").toLowerCase();
  const reference = params.get("tx_ref") || params.get("reference") || "";
  const transactionId = params.get("transaction_id") || params.get("id") || "";

  if (status === "failed" || status === "cancelled") {
    return subscriptionRedirect(request, "cancelled");
  }
  if (!reference || !transactionId) {
    return subscriptionRedirect(request, "pending");
  }

  try {
    const completed = await completeVerifiedFlutterwavePayment(reference, transactionId);
    return subscriptionRedirect(request, completed ? "success" : "pending");
  } catch {
    return subscriptionRedirect(request, "pending");
  }
}
