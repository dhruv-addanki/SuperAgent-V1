import crypto from "node:crypto";
import { env } from "../config/env";

const algorithm = "aes-256-gcm";

function getKey(): Buffer {
  const raw = env.ENCRYPTION_KEY;
  if (/^[A-Za-z0-9+/=]{44}$/.test(raw)) {
    try {
      return crypto.createHash("sha256").update(Buffer.from(raw, "base64")).digest();
    } catch {
      return crypto.createHash("sha256").update(raw).digest();
    }
  }
  return crypto.createHash("sha256").update(raw).digest();
}

export function encryptString(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(algorithm, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString("base64url")).join(".");
}

export function decryptString(encrypted: string): string {
  const [ivValue, tagValue, ciphertextValue] = encrypted.split(".");
  if (!ivValue || !tagValue || !ciphertextValue) {
    throw new Error("Invalid encrypted payload");
  }

  const decipher = crypto.createDecipheriv(algorithm, getKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final()
  ]);
  return plaintext.toString("utf8");
}
