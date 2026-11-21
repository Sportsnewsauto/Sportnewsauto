import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;

function encryptionKey(): Buffer {
  const configured = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!configured) throw new Error("Credential vault is not configured. Add CREDENTIAL_ENCRYPTION_KEY to the Vercel environment variables.");
  const key = Buffer.from(configured.trim(), "base64");
  if (key.length !== KEY_BYTES) throw new Error("CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  return key;
}

export function encryptCredential(plaintext: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    auth_tag: cipher.getAuthTag().toString("base64"),
    key_version: "aes-256-gcm-v1",
  };
}

export function decryptCredential(record: { ciphertext: string; iv: string; auth_tag: string }): string {
  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.auth_tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
