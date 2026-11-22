import "server-only";
import { createAdminClient } from "@/lib/server/supabase-admin";

type FlutterwaveTransaction = {
  id: string | number;
  tx_ref: string;
  status: string;
  amount: number | string;
  currency: string;
  [key: string]: unknown;
};

export function isFlutterwaveConfigured() {
  return Boolean(process.env.FLUTTERWAVE_SECRET_KEY?.trim());
}

/**
 * Verifies a transaction directly against Flutterwave before any subscription
 * is activated. Both browser redirects and webhooks use this same path.
 */
export async function completeVerifiedFlutterwavePayment(txRef: string, transactionId: string) {
  const secretKey = process.env.FLUTTERWAVE_SECRET_KEY?.trim();
  if (!secretKey || !txRef || !transactionId) return false;

  const admin = createAdminClient();
  const { data: payment, error: paymentError } = await admin
    .from("billing_payments")
    .select("id,amount_ksh,status,payment_provider,flutterwave_transaction_id")
    .eq("tx_ref", txRef)
    .eq("payment_provider", "flutterwave")
    .maybeSingle();

  if (paymentError || !payment) return false;

  const response = await fetch(
    `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(transactionId)}/verify`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) return false;

  const envelope = await response.json() as {
    status?: string;
    data?: FlutterwaveTransaction;
  };
  const transaction = envelope.data;
  if (
    envelope.status !== "success" ||
    !transaction ||
    String(transaction.id) !== transactionId ||
    transaction.tx_ref !== txRef ||
    transaction.status !== "successful" ||
    String(transaction.currency).toUpperCase() !== "KES" ||
    !Number.isSafeInteger(Number(transaction.amount)) ||
    Number(transaction.amount) !== Number(payment.amount_ksh)
  ) {
    return false;
  }

  const { error } = await admin.rpc("complete_flutterwave_subscription", {
    p_tx_ref: txRef,
    p_transaction_id: transactionId,
    p_amount: Number(transaction.amount),
    p_currency: String(transaction.currency),
    p_callback_payload: envelope,
  });

  return !error;
}
