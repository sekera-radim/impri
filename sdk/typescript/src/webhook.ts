import { createHmac, timingSafeEqual } from 'node:crypto'
import { ImpriWebhookSignatureError } from './errors.js'

/**
 * Verify an Impri webhook delivery.
 *
 * Algorithm: HMAC-SHA256(secret, `${timestamp}.${nonce}.${rawBody}`)
 * compared constant-time against the sha256= prefix of X-Impri-Signature.
 *
 * Headers to pass:
 *   - X-Impri-Signature  → signature parameter  (e.g. "sha256=abc...")
 *   - X-Impri-Timestamp  → timestamp parameter   (Unix seconds as string)
 *   - X-Impri-Nonce      → nonce parameter        (hex string)
 *
 * @throws {ImpriWebhookSignatureError} if the signature is missing, malformed,
 *   stale (outside toleranceSec window), or does not match.
 */
export function verifyWebhook(
  rawBody: Buffer | string,
  secret: string,
  timestamp: string,
  nonce: string,
  signature: string,
  opts: { toleranceSec?: number } = {},
): void {
  const toleranceSec = opts.toleranceSec ?? 300

  if (!signature.startsWith('sha256=')) {
    throw new ImpriWebhookSignatureError(
      'X-Impri-Signature header is missing or does not start with "sha256=".',
    )
  }

  const expectedHex = signature.slice(7)

  const ts = parseInt(timestamp, 10)
  if (Number.isNaN(ts)) {
    throw new ImpriWebhookSignatureError(
      'X-Impri-Timestamp header is missing or is not a valid integer.',
    )
  }

  const nowSec = Math.floor(Date.now() / 1000)
  if (Math.abs(nowSec - ts) > toleranceSec) {
    throw new ImpriWebhookSignatureError(
      `Webhook timestamp is outside the ${toleranceSec}s tolerance window ` +
        '(replay protection). Ensure your server clock is synced.',
    )
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody
  const signingPayload = `${ts}.${nonce}.${body}`
  const actualHex = createHmac('sha256', secret).update(signingPayload, 'utf8').digest('hex')

  // Constant-time comparison to prevent timing side-channel attacks.
  let mismatch = false
  try {
    const expected = Buffer.from(expectedHex, 'hex')
    const actual = Buffer.from(actualHex, 'hex')
    if (expected.length !== actual.length) {
      mismatch = true
    } else {
      mismatch = !timingSafeEqual(expected, actual)
    }
  } catch {
    mismatch = true
  }

  if (mismatch) {
    throw new ImpriWebhookSignatureError(
      'Webhook signature does not match. Verify the secret matches the value from GET /v1/project.',
    )
  }
}
