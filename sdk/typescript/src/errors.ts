import type { Decision, Preview } from './types.js'

/** Base class for all Impri SDK errors. */
export class ImpriError extends Error {
  constructor(message: string) {
    super(message)
    this.name = this.constructor.name
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor)
    }
  }
}

/** API key is missing at construction time, or baseUrl is malformed. */
export class ImpriConfigError extends ImpriError {
  constructor(message: string) {
    super(message)
  }
}

/** HTTP 401 / 403 — missing/wrong key or key lacks the required scope. */
export class ImpriUnauthorized extends ImpriError {
  statusCode: number
  responseBody: unknown
  constructor(message: string, statusCode: number, responseBody: unknown) {
    super(message)
    this.statusCode = statusCode
    this.responseBody = responseBody
  }
}

/** HTTP 404 — action/watcher not found or belongs to a different project. */
export class ImpriNotFound extends ImpriError {
  statusCode = 404
  responseBody: unknown
  constructor(message: string, responseBody: unknown) {
    super(message)
    this.responseBody = responseBody
  }
}

/**
 * HTTP 409 — action already decided; concurrent idempotency race resolved by
 * another writer; or reportResult called on a non-approved action.
 */
export class ImpriConflict extends ImpriError {
  statusCode = 409
  responseBody: unknown
  constructor(message: string, responseBody: unknown) {
    super(message)
    this.responseBody = responseBody
  }
}

/**
 * HTTP 410 — approval window closed; also raised by awaitDecision when
 * action.status === 'expired'.
 */
export class ImpriExpired extends ImpriError {
  statusCode = 410
  responseBody: unknown
  constructor(message: string, responseBody: unknown) {
    super(message)
    this.responseBody = responseBody
  }
}

/** HTTP 429 — per-key rate limit hit. Check retryAfter for the backoff hint. */
export class ImpriRateLimited extends ImpriError {
  statusCode = 429
  responseBody: unknown
  /** Seconds to wait before retrying, from the Retry-After header. */
  retryAfter?: number
  constructor(message: string, responseBody: unknown, retryAfter?: number) {
    super(message)
    this.responseBody = responseBody
    this.retryAfter = retryAfter
  }
}

/**
 * HTTP 402 — monthly approval limit or watcher count limit reached (cloud
 * tiers). Check limit and tier for details.
 */
export class ImpriQuotaExceeded extends ImpriError {
  statusCode = 402
  responseBody: unknown
  limit?: number
  tier?: string
  constructor(message: string, responseBody: unknown, limit?: number, tier?: string) {
    super(message)
    this.responseBody = responseBody
    this.limit = limit
    this.tier = tier
  }
}

/** HTTP 400 / 422 — server-side schema validation failed. */
export class ImpriValidationError extends ImpriError {
  statusCode: number
  responseBody: unknown
  /** Zod-format issues array from the response body. */
  issues: unknown[]
  constructor(message: string, statusCode: number, responseBody: unknown, issues: unknown[]) {
    super(message)
    this.statusCode = statusCode
    this.responseBody = responseBody
    this.issues = issues
  }
}

/** Catch-all for unexpected 4xx/5xx responses. */
export class ImpriApiError extends ImpriError {
  statusCode: number
  responseBody: unknown
  constructor(message: string, statusCode: number, responseBody: unknown) {
    super(message)
    this.statusCode = statusCode
    this.responseBody = responseBody
  }
}

/**
 * Raised by awaitDecision when the human rejects the action.
 *
 * This is a valid flow outcome — catch and handle it gracefully.
 * Do NOT log it as an error or retry the action.
 */
export class ImpriRejected extends ImpriError {
  /** The action ID that was rejected. */
  actionId: string
  /** The decision object from the human reviewer. */
  decision: Decision
  /** The reviewer's final preview (may differ from original if they edited it). */
  finalPreview?: Preview
  statusCode: undefined
  responseBody: undefined
  constructor(actionId: string, decision: Decision, finalPreview?: Preview) {
    super(`Action ${actionId} was rejected by the human reviewer.`)
    this.actionId = actionId
    this.decision = decision
    this.finalPreview = finalPreview
    this.statusCode = undefined
    this.responseBody = undefined
  }
}

/**
 * Raised by awaitDecision when timeoutS elapses with the action still pending.
 *
 * The action remains pending server-side. Call awaitDecision again to resume
 * waiting, or poll separately.
 */
export class ImpriTimeout extends ImpriError {
  /** The action ID that timed out. */
  actionId: string
  statusCode: undefined
  responseBody: undefined
  constructor(actionId: string, timeoutS: number) {
    super(
      `Timed out after ${timeoutS}s waiting for decision on action ${actionId}. ` +
        'The action remains pending — call awaitDecision again to resume.',
    )
    this.actionId = actionId
    this.statusCode = undefined
    this.responseBody = undefined
  }
}

/**
 * Raised by verifyWebhook when the signature is invalid, stale, or malformed.
 */
export class ImpriWebhookSignatureError extends ImpriError {
  constructor(message = 'Webhook signature verification failed.') {
    super(message)
  }
}
