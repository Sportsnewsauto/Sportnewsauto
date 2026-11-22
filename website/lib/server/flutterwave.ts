import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/server/supabase-admin";

const TOKEN_URL = "https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token";
const API_BASE_URL = "https://f4bexperience.flutterwave.com";

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type ApiEnvelope<T> = {
  status?: string;
  message?: string;
  error?: { code?: string; message?: string } | string;
  data?: T;
};

function safeProviderMessage(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  return value
    .replace(/[\\r\\n\\t]+/g, " ")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/gi, "[email]")
    .replace(/(?:Bearer\\s+)\\S+/gi, "Bearer [redacted]")
    .replace(/\\b(?:254|0)?[17]\\d{8}\\b/g, "[phone]")
    .slice(0, 180);
}

type FlutterwaveCharge = {
  id: string;
  reference: string;
  status: string;
  amount: number | string;
  currency: string;
  [key: string]: unknown;
};

type MobileNetwork = {
  id?: string;
  network?: string;
  name?: string;
};

type RequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  idempotencyKey?: string;
};

let cachedAccessToken = "";
let cachedAccessTokenExpiresAt = 0;

function clientId() {
  return process.env.FLUTTERWAVE_CLIENT_ID?.trim() || "";
}

function clientSecret() {
  return process.env.FLUTTERWAVE_CLIENT_SECRET?.trim() || "";
}

export function isFlutterwaveConfigured() {
  return Boolean(
    clientId() &&
    clientSecret() &&
    process.env.FLUTTERWAVE_WEBHOOK_HASH?.trim()
  );
}

async function getAccessToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt) {
    return cachedAccessToken;
  }

  const id = clientId();
  const secret = clientSecret();
  if (!id || !secret) {
    throw new Error("Flutterwave V4 Client ID and Client Secret are not configured.");
  }

  const form = new URLSearchParams({
    client_id: id,
    client_secret: secret,
    grant_type: "client_credentials",
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });

  const result = await response.json().catch(() => ({})) as TokenResponse;
  if (!response.ok || typeof result.access_token !== "string" || !result.access_token) {
    cachedAccessToken = "";
    cachedAccessTokenExpiresAt = 0;
    const reason = safeProviderMessage(result.error_description || result.error);
    throw new Error(
      `Flutterwave OAuth authentication failed (HTTP ${response.status})${reason ? `: ${reason}` : ". Check the live Client ID and Client Secret."}`,
    );
  }

  cachedAccessToken = result.access_token;
  const lifetimeSeconds = Math.max(60, Number(result.expires_in) || 600);
  cachedAccessTokenExpiresAt = Date.now() + Math.max(30, lifetimeSeconds - 60) * 1000;
  return cachedAccessToken;
}

export async function flutterwaveV4Request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<ApiEnvelope<T>> {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Invalid Flutterwave API path.");
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getAccessToken(attempt > 0);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "X-Trace-Id": randomUUID(),
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["X-Idempotency-Key"] = options.idempotencyKey;

    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });

    const result = await response.json().catch(() => ({})) as ApiEnvelope<T>;
    if (response.status === 401 && attempt === 0) {
      cachedAccessToken = "";
      cachedAccessTokenExpiresAt = 0;
      continue;
    }
    if (!response.ok || result.status === "failed") {
      const errorObject = typeof result.error === "object" && result.error !== null ? result.error : null;
      const code = errorObject?.code;
      const message = safeProviderMessage(
        errorObject?.message || (typeof result.error === "string" ? result.error : result.message),
      );
      throw new Error(
        `Flutterwave API rejected the request (HTTP ${response.status}${code ? `, code ${safeProviderMessage(code)}` : ""})${message ? `: ${message}` : "."}`,
      );
    }
    return result;
  }

  throw new Error("Flutterwave V4 authentication expired. Please try again.");
}

export async function getKenyanMpesaNetwork(): Promise<string> {
  const result = await flutterwaveV4Request<MobileNetwork[]>("/mobile-networks?country=KE");
  const networks = Array.isArray(result.data) ? result.data : [];
  const mpesa = networks.find((item) => {
    const label = `${item.name || ""} ${item.network || ""}`;
    return /m[\s-]?pesa|safaricom/i.test(label) || String(item.network || "").toUpperCase() === "MPS";
  });

  if (!mpesa?.network) {
    throw new Error("Flutterwave did not return a supported M-Pesa network for Kenya.");
  }

  // The V4 payment-method endpoint expects its canonical network code.
  // The mobile-networks discovery response can label the Kenyan operator
  // as "SAFARICOM", but V4 explicitly accepts "MPESA" for Kenya.
  return "MPESA";
}

export function verifyFlutterwaveV3WebhookHash(providedHash: string): boolean {
  const expectedHash = process.env.FLUTTERWAVE_WEBHOOK_HASH?.trim();
  if (!expectedHash || !providedHash) return false;
  const expected = Buffer.from(expectedHash, "utf8");
  const provided = Buffer.from(providedHash, "utf8");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export function isFlutterwaveCardCheckoutConfigured() {
  return Boolean(
    process.env.FLUTTERWAVE_V3_SECRET_KEY?.trim() &&
    isFlutterwaveConfigured()
  );
}

/**
 * Verify a V3 hosted-card transaction directly with Flutterwave before
 * allowing the shared subscription RPC to activate access.
 */
export async function completeVerifiedFlutterwaveCardPayment(reference: string, transactionId: string) {
  const secretKey = process.env.FLUTTERWAVE_V3_SECRET_KEY?.trim();
  if (!reference.startsWith("pc") || !transactionId || !secretKey || !isFlutterwaveConfigured()) {
    return false;
  }

  const admin = createAdminClient();
  const { data: payment, error: paymentError } = await admin
    .from("billing_payments")
    .select("id,amount_ksh,status,payment_provider,flutterwave_transaction_id")
    .eq("tx_ref", reference)
    .eq("payment_provider", "flutterwave")
    .maybeSingle();

  if (paymentError || !payment || payment.status === "failed") return false;
  if (payment.flutterwave_transaction_id && payment.flutterwave_transaction_id !== transactionId) {
    return false;
  }

  const response = await fetch(
    `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(transactionId)}/verify`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    },
  );
  const envelope = await response.json().catch(() => ({})) as {
    status?: string;
    message?: string;
    data?: {
      id?: string | number;
      tx_ref?: string;
      status?: string;
      amount?: number | string;
      currency?: string;
      payment_type?: string;
    };
  };

  const transaction = envelope.data;
  if (
    !response.ok ||
    envelope.status !== "success" ||
    !transaction ||
    String(transaction.id) !== transactionId ||
    transaction.tx_ref !== reference ||
    String(transaction.status).toLowerCase() !== "successful" ||
    String(transaction.payment_type).toLowerCase() !== "card" ||
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
    p_callback_payload: {
      verification_source: "flutterwave_v3_hosted_card",
      transaction: transaction,
    },
  });

  return !error;
}

/**
 * V4 webhooks sign the unmodified request body with HMAC-SHA256 and Base64.
 * The raw body must be verified before JSON parsing.
 */
export function verifyFlutterwaveV4WebhookSignature(rawBody: string, signature: string): boolean {
  const secretHash = process.env.FLUTTERWAVE_WEBHOOK_HASH?.trim();
  if (!secretHash || !signature) return false;

  const expected = createHmac("sha256", secretHash).update(rawBody, "utf8").digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "base64");
  } catch {
    return false;
  }

  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/**
 * Always retrieve the charge from Flutterwave before activating a subscription.
 * V4 uses the charge reference/status fields (reference / succeeded), not the
 * V3 transaction fields (tx_ref / successful).
 */
export async function completeVerifiedFlutterwavePayment(reference: string, chargeId: string) {
  if (!reference || !chargeId || !isFlutterwaveConfigured()) return false;

  const admin = createAdminClient();
  const { data: payment, error: paymentError } = await admin
    .from("billing_payments")
    .select("id,amount_ksh,status,payment_provider,flutterwave_transaction_id")
    .eq("tx_ref", reference)
    .eq("payment_provider", "flutterwave")
    .maybeSingle();

  if (paymentError || !payment || payment.status === "failed") return false;
  if (payment.flutterwave_transaction_id && payment.flutterwave_transaction_id !== chargeId) {
    return false;
  }

  const envelope = await flutterwaveV4Request<FlutterwaveCharge>(
    `/charges/${encodeURIComponent(chargeId)}`,
  );
  const charge = envelope.data;
  if (
    envelope.status !== "success" ||
    !charge ||
    String(charge.id) !== chargeId ||
    charge.reference !== reference ||
    String(charge.status).toLowerCase() !== "succeeded" ||
    String(charge.currency).toUpperCase() !== "KES" ||
    !Number.isSafeInteger(Number(charge.amount)) ||
    Number(charge.amount) !== Number(payment.amount_ksh)
  ) {
    return false;
  }

  const { error } = await admin.rpc("complete_flutterwave_subscription", {
    p_tx_ref: reference,
    p_transaction_id: chargeId,
    p_amount: Number(charge.amount),
    p_currency: String(charge.currency),
    p_callback_payload: envelope,
  });

  return !error;
}
