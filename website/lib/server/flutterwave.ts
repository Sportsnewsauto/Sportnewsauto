import "server-only";
import { timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/server/supabase-admin";

const API_BASE_URL = "https://api.flutterwave.com/v3";

type ApiEnvelope<T> = {
  status?: string;
  message?: string;
  data?: T;
  error?: { code?: string; message?: string } | string;
};

type FlutterwaveTransaction = {
  id?: string | number;
  tx_ref?: string;
  status?: string;
  amount?: number | string;
  currency?: string;
  [key: string]: unknown;
};

type RequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
};

function secretKey() {
  return process.env.FLUTTERWAVE_SECRET_KEY?.trim() || "";
}

function safeProviderMessage(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(?:Bearer\s+)\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:254|0)?[17]\d{8}\b/g, "[phone]")
    .slice(0, 180);
}

/**
 * V3 Standard uses one secret key for hosted card and M-Pesa checkout.
 * The webhook hash is also required so successful payments can be verified
 * before Podcasti activates a subscription.
 */
export function isFlutterwaveConfigured() {
  return Boolean(secretKey() && process.env.FLUTTERWAVE_WEBHOOK_HASH?.trim());
}

export async function flutterwaveV3Request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<ApiEnvelope<T>> {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Invalid Flutterwave API path.");
  }
  const key = secretKey();
  if (!key) {
    throw new Error("Flutterwave V3 Secret Key is not configured.");
  }

  const response = await fetch(API_BASE_URL + path, {
    method: options.method || "GET",
    headers: {
      Authorization: "Bearer " + key,
      Accept: "application/json",
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });

  const result = await response.json().catch(() => ({})) as ApiEnvelope<T>;
  if (!response.ok || result.status === "error" || result.status === "failed") {
    const errorObject = typeof result.error === "object" && result.error !== null ? result.error : null;
    const message = safeProviderMessage(
      errorObject?.message || (typeof result.error === "string" ? result.error : result.message),
    );
    throw new Error(
      "Flutterwave API rejected the request (HTTP " + response.status + ")" +
      (message ? ": " + message : "."),
    );
  }
  return result;
}

/**
 * V3 webhooks use the configured secret hash in the "verif-hash" header.
 * Compare in constant time; do not use the V4 raw-body HMAC scheme here.
 */
export function verifyFlutterwaveWebhookHash(signature: string): boolean {
  const secretHash = process.env.FLUTTERWAVE_WEBHOOK_HASH?.trim();
  if (!secretHash || !signature) return false;
  const expected = Buffer.from(secretHash, "utf8");
  const provided = Buffer.from(signature, "utf8");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

/**
 * Always verify a V3 transaction with Flutterwave before the subscription RPC.
 * Redirect query parameters and webhook payload values are only identifiers,
 * never proof that the customer paid.
 */
export async function completeVerifiedFlutterwavePayment(reference: string, transactionId: string) {
  if (!reference || !transactionId || !isFlutterwaveConfigured()) return false;

  const admin = createAdminClient();
  const { data: payment, error: paymentError } = await admin
    .from("billing_payments")
    .select("id,amount_ksh,status,payment_provider,flutterwave_transaction_id")
    .eq("tx_ref", reference)
    .eq("payment_provider", "flutterwave")
    .maybeSingle();

  if (paymentError || !payment || payment.status === "failed") return false;
  if (
    payment.flutterwave_transaction_id &&
    String(payment.flutterwave_transaction_id) !== transactionId
  ) {
    return false;
  }

  const envelope = await flutterwaveV3Request<FlutterwaveTransaction>(
    "/transactions/" + encodeURIComponent(transactionId) + "/verify",
  );
  const transaction = envelope.data;
  if (
    envelope.status !== "success" ||
    !transaction ||
    String(transaction.id) !== transactionId ||
    transaction.tx_ref !== reference ||
    String(transaction.status).toLowerCase() !== "successful" ||
    String(transaction.currency).toUpperCase() !== "KES" ||
    !Number.isSafeInteger(Number(transaction.amount)) ||
    Number(transaction.amount) !== Number(payment.amount_ksh)
  ) {
    return false;
  }

  const { error } = await admin.rpc("complete_flutterwave_subscription", {
    p_tx_ref: reference,
    p_transaction_id: transactionId,
    p_amount: Number(transaction.amount),
    p_currency: String(transaction.currency),
    p_callback_payload: envelope,
  });

  return !error;
}
