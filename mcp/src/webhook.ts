import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyWebhookSignatureParams {
  /** Webhook secret you configured when registering the endpoint. */
  secret: string;
  /** Raw request body as a string — do not parse it first. */
  rawBody: string;
  /** Value of the `X-Impri-Signature` header (e.g. `"sha256=abc123..."`). */
  signatureHeader: string;
  /** Value of the `X-Impri-Timestamp` header (Unix epoch seconds as a string). */
  timestampHeader: string;
  /** Value of the `X-Impri-Nonce` header (hex string). */
  nonceHeader: string;
  /**
   * Maximum allowed age of the request in seconds. Requests older than this
   * are rejected to prevent replay attacks. Defaults to 300 (5 minutes).
   */
  toleranceSec?: number;
}

/**
 * Verify an Impri webhook delivery.
 *
 * Impri signs each webhook body using HMAC-SHA256 over the string
 * `${timestamp}.${nonce}.${rawBody}` and sends the result in the
 * `X-Impri-Signature` header as `sha256=<hex>`. The timestamp and nonce are
 * sent in `X-Impri-Timestamp` and `X-Impri-Nonce` respectively.
 *
 * This function performs a constant-time comparison and rejects requests whose
 * timestamp falls outside the tolerance window (replay protection).
 *
 * @returns `true` if the signature is valid and the timestamp is fresh.
 */
export function verifyWebhookSignature(params: VerifyWebhookSignatureParams): boolean {
  const {
    secret,
    rawBody,
    signatureHeader,
    timestampHeader,
    nonceHeader,
    toleranceSec = 300,
  } = params;

  // Reject requests with missing or malformed signature header.
  if (!signatureHeader.startsWith("sha256=")) return false;
  const expectedHex = signatureHeader.slice(7);

  // Reject requests with a timestamp outside the tolerance window.
  const timestamp = parseInt(timestampHeader, 10);
  if (isNaN(timestamp)) return false;

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestamp) > toleranceSec) return false;

  // Recompute the signature using the same payload formula as the server:
  // `${timestamp}.${nonce}.${rawBody}`
  const payload = `${timestamp}.${nonceHeader}.${rawBody}`;
  const actualHex = createHmac("sha256", secret).update(payload).digest("hex");

  // Constant-time comparison to prevent timing side-channel attacks.
  try {
    const expected = Buffer.from(expectedHex, "hex");
    const actual = Buffer.from(actualHex, "hex");
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
