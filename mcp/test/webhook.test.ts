import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "../src/webhook.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SECRET = "test_webhook_secret_abc123";

/** Reproduce the server-side signing formula: `sha256=HMAC(secret, "${ts}.${nonce}.${body}")` */
function sign(secret: string, body: string, timestamp: number, nonce: string): string {
  const payload = `${timestamp}.${nonce}.${body}`;
  const hex = createHmac("sha256", secret).update(payload).digest("hex");
  return `sha256=${hex}`;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

const BODY = JSON.stringify({ event: "action.updated", action_id: "act_001", status: "approved" });
const NONCE = "a1b2c3d4e5f60000";

// ─── verifyWebhookSignature ───────────────────────────────────────────────────

describe("verifyWebhookSignature", () => {
  it("returns true for a valid signature with a fresh timestamp", () => {
    const ts = nowSec();
    const sig = sign(SECRET, BODY, ts, NONCE);

    expect(
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        signatureHeader: sig,
        timestampHeader: String(ts),
        nonceHeader: NONCE,
      }),
    ).toBe(true);
  });

  it("returns false when the request body has been tampered with", () => {
    const ts = nowSec();
    const originalBody = BODY;
    const tamperedBody = JSON.stringify({ event: "action.updated", action_id: "act_EVIL", status: "approved" });
    const sig = sign(SECRET, originalBody, ts, NONCE);

    expect(
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: tamperedBody,   // body changed after signing
        signatureHeader: sig,
        timestampHeader: String(ts),
        nonceHeader: NONCE,
      }),
    ).toBe(false);
  });

  it("returns false when the nonce does not match the one used for signing", () => {
    const ts = nowSec();
    const sig = sign(SECRET, BODY, ts, NONCE);

    expect(
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        signatureHeader: sig,
        timestampHeader: String(ts),
        nonceHeader: "0000000000000000",   // different nonce
      }),
    ).toBe(false);
  });

  it("returns false when the timestamp is older than the default tolerance (300 s)", () => {
    const staleTs = nowSec() - 400;   // 400 s ago — well outside the 300 s window
    const sig = sign(SECRET, BODY, staleTs, NONCE);

    expect(
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        signatureHeader: sig,
        timestampHeader: String(staleTs),
        nonceHeader: NONCE,
      }),
    ).toBe(false);
  });

  it("accepts a timestamp within a custom tolerance window", () => {
    const ts = nowSec() - 100;   // 100 s ago
    const sig = sign(SECRET, BODY, ts, NONCE);

    expect(
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        signatureHeader: sig,
        timestampHeader: String(ts),
        nonceHeader: NONCE,
        toleranceSec: 200,   // wider window — should accept
      }),
    ).toBe(true);
  });

  it("returns false when the signature uses a different secret", () => {
    const ts = nowSec();
    const wrongSig = sign("wrong_secret_xyz", BODY, ts, NONCE);

    expect(
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        signatureHeader: wrongSig,
        timestampHeader: String(ts),
        nonceHeader: NONCE,
      }),
    ).toBe(false);
  });

  it("returns false when signatureHeader has no sha256= prefix", () => {
    const ts = nowSec();
    // Strip the "sha256=" prefix — malformed header
    const rawHex = sign(SECRET, BODY, ts, NONCE).slice(7);

    expect(
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        signatureHeader: rawHex,
        timestampHeader: String(ts),
        nonceHeader: NONCE,
      }),
    ).toBe(false);
  });

  it("returns false for a non-numeric timestamp header", () => {
    const ts = nowSec();
    const sig = sign(SECRET, BODY, ts, NONCE);

    expect(
      verifyWebhookSignature({
        secret: SECRET,
        rawBody: BODY,
        signatureHeader: sig,
        timestampHeader: "not-a-number",
        nonceHeader: NONCE,
      }),
    ).toBe(false);
  });
});
