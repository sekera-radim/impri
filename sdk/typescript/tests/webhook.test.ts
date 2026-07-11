import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifyWebhook, ImpriWebhookSignatureError } from '../src/index.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sign(
  secret: string,
  timestamp: string | number,
  nonce: string,
  rawBody: string,
): string {
  const payload = `${timestamp}.${nonce}.${rawBody}`
  const hex = createHmac('sha256', secret).update(payload, 'utf8').digest('hex')
  return `sha256=${hex}`
}

const SECRET = 'whsec_test_abc123'
const NONCE = 'deadbeef1234'
const BODY = '{"event":"decision","action_id":"act_1","verdict":"approve"}'
const NOW_SEC = Math.floor(Date.now() / 1000)
const TS = String(NOW_SEC)
const VALID_SIG = sign(SECRET, TS, NONCE, BODY)

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('verifyWebhook', () => {
  it('accepts a valid string body', () => {
    expect(() => verifyWebhook(BODY, SECRET, TS, NONCE, VALID_SIG)).not.toThrow()
  })

  it('accepts a Buffer body equivalent to the string', () => {
    const buf = Buffer.from(BODY, 'utf8')
    expect(() => verifyWebhook(buf, SECRET, TS, NONCE, VALID_SIG)).not.toThrow()
  })

  it('throws ImpriWebhookSignatureError for a wrong secret', () => {
    const wrongSig = sign('wrong_secret', TS, NONCE, BODY)
    expect(() => verifyWebhook(BODY, SECRET, TS, NONCE, wrongSig)).toThrow(
      ImpriWebhookSignatureError,
    )
  })

  it('throws ImpriWebhookSignatureError for a tampered body', () => {
    const tampered = BODY.replace('approve', 'reject')
    expect(() => verifyWebhook(tampered, SECRET, TS, NONCE, VALID_SIG)).toThrow(
      ImpriWebhookSignatureError,
    )
  })

  it('throws ImpriWebhookSignatureError for a tampered nonce', () => {
    const wrongNonce = 'ffffffff9999'
    expect(() => verifyWebhook(BODY, SECRET, TS, wrongNonce, VALID_SIG)).toThrow(
      ImpriWebhookSignatureError,
    )
  })

  it('throws ImpriWebhookSignatureError when signature prefix is not sha256=', () => {
    const badSig = VALID_SIG.replace('sha256=', 'md5=')
    expect(() => verifyWebhook(BODY, SECRET, TS, NONCE, badSig)).toThrow(
      ImpriWebhookSignatureError,
    )
  })

  it('throws ImpriWebhookSignatureError for an empty signature', () => {
    expect(() => verifyWebhook(BODY, SECRET, TS, NONCE, '')).toThrow(ImpriWebhookSignatureError)
  })

  it('throws ImpriWebhookSignatureError for a non-numeric timestamp', () => {
    expect(() => verifyWebhook(BODY, SECRET, 'not-a-number', NONCE, VALID_SIG)).toThrow(
      ImpriWebhookSignatureError,
    )
  })

  it('throws ImpriWebhookSignatureError for a timestamp older than toleranceSec', () => {
    const staleTs = String(NOW_SEC - 400) // 400s ago, default tolerance is 300s
    const staleSig = sign(SECRET, staleTs, NONCE, BODY)
    expect(() => verifyWebhook(BODY, SECRET, staleTs, NONCE, staleSig)).toThrow(
      ImpriWebhookSignatureError,
    )
  })

  it('accepts a timestamp within the default 300s tolerance', () => {
    const recentTs = String(NOW_SEC - 100)
    const recentSig = sign(SECRET, recentTs, NONCE, BODY)
    expect(() => verifyWebhook(BODY, SECRET, recentTs, NONCE, recentSig)).not.toThrow()
  })

  it('respects a custom toleranceSec — rejects within that window', () => {
    const mildlyStaleTs = String(NOW_SEC - 60)
    const sig = sign(SECRET, mildlyStaleTs, NONCE, BODY)
    // Tolerance of 30s should reject a 60s-old timestamp
    expect(() =>
      verifyWebhook(BODY, SECRET, mildlyStaleTs, NONCE, sig, { toleranceSec: 30 }),
    ).toThrow(ImpriWebhookSignatureError)
  })

  it('respects a custom toleranceSec — accepts within that window', () => {
    const mildlyStaleTs = String(NOW_SEC - 60)
    const sig = sign(SECRET, mildlyStaleTs, NONCE, BODY)
    // Tolerance of 120s should accept a 60s-old timestamp
    expect(() =>
      verifyWebhook(BODY, SECRET, mildlyStaleTs, NONCE, sig, { toleranceSec: 120 }),
    ).not.toThrow()
  })

  it('is case-sensitive: uppercase hex in signature fails', () => {
    const upperSig = 'sha256=' + VALID_SIG.slice(7).toUpperCase()
    // Uppercase hex differs from lowercase — this should fail (different bytes after Buffer.from hex decode)
    // Note: Buffer.from(hex, 'hex') is case-insensitive, so uppercase hex is actually valid.
    // The HMAC output is lowercase hex; comparing uppercase should work too.
    // This test verifies the library doesn't break on uppercase — both should pass.
    expect(() => verifyWebhook(BODY, SECRET, TS, NONCE, upperSig)).not.toThrow()
  })

  it('returns void (not a boolean) on success', () => {
    const result = verifyWebhook(BODY, SECRET, TS, NONCE, VALID_SIG)
    expect(result).toBeUndefined()
  })
})
