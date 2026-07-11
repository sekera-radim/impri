/**
 * Error class hierarchy for the Impri Claude Agent SDK integration.
 * All errors extend ImpriError so callers can catch the base type if needed.
 */

export class ImpriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImpriError";
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }
}

/** API key missing at construction time, or base URL is malformed. */
export class ImpriConfigError extends ImpriError {
  constructor(message: string) {
    super(message);
    this.name = "ImpriConfigError";
  }
}

/** 401 / 403: key missing, wrong, or lacks the required scope. */
export class ImpriUnauthorized extends ImpriError {
  readonly statusCode: number;
  readonly responseBody: unknown;
  constructor(message: string, statusCode: number, responseBody: unknown) {
    super(message);
    this.name = "ImpriUnauthorized";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

/** 404: action or watcher not found, or belongs to a different project. */
export class ImpriNotFound extends ImpriError {
  readonly statusCode = 404;
  readonly responseBody: unknown;
  constructor(message: string, responseBody: unknown) {
    super(message);
    this.name = "ImpriNotFound";
    this.responseBody = responseBody;
  }
}

/** 409: action already decided; result called on non-approved action; idempotency race. */
export class ImpriConflict extends ImpriError {
  readonly statusCode = 409;
  readonly responseBody: unknown;
  constructor(message: string, responseBody: unknown) {
    super(message);
    this.name = "ImpriConflict";
    this.responseBody = responseBody;
  }
}

/** 410: the approval window closed before a decision was made. */
export class ImpriExpired extends ImpriError {
  readonly statusCode = 410;
  readonly responseBody: unknown;
  constructor(message: string, responseBody: unknown) {
    super(message);
    this.name = "ImpriExpired";
    this.responseBody = responseBody;
  }
}

/** 429: per-key rate limit hit; retry after retryAfter seconds if provided. */
export class ImpriRateLimited extends ImpriError {
  readonly statusCode = 429;
  readonly responseBody: unknown;
  readonly retryAfter: number | undefined;
  constructor(message: string, responseBody: unknown, retryAfter?: number) {
    super(message);
    this.name = "ImpriRateLimited";
    this.responseBody = responseBody;
    this.retryAfter = retryAfter;
  }
}

/** 402: monthly approval quota or watcher count limit reached (cloud tiers). */
export class ImpriQuotaExceeded extends ImpriError {
  readonly statusCode = 402;
  readonly responseBody: unknown;
  constructor(message: string, responseBody: unknown) {
    super(message);
    this.name = "ImpriQuotaExceeded";
    this.responseBody = responseBody;
  }
}

/** 400 / 422: server-side schema validation failed; issues contains Zod error list. */
export class ImpriValidationError extends ImpriError {
  readonly statusCode: number;
  readonly responseBody: unknown;
  readonly issues: unknown[];
  constructor(
    message: string,
    statusCode: number,
    responseBody: unknown,
    issues: unknown[] = [],
  ) {
    super(message);
    this.name = "ImpriValidationError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
    this.issues = issues;
  }
}

/** Catch-all for unexpected 4xx / 5xx responses not covered by the above. */
export class ImpriApiError extends ImpriError {
  readonly statusCode: number;
  readonly responseBody: unknown;
  constructor(message: string, statusCode: number, responseBody: unknown) {
    super(message);
    this.name = "ImpriApiError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

/**
 * Raised by awaitDecision when the human rejected the action.
 * This is a valid workflow outcome — do NOT log it as an error.
 * Catch it separately and handle it as "human said no".
 */
export class ImpriRejected extends ImpriError {
  readonly actionId: string;
  readonly decision: unknown;
  readonly finalPreview: { format: string; body: string } | undefined;
  constructor(
    actionId: string,
    decision: unknown,
    finalPreview?: { format: string; body: string },
  ) {
    super(`Action ${actionId} was rejected by the human reviewer.`);
    this.name = "ImpriRejected";
    this.actionId = actionId;
    this.decision = decision;
    this.finalPreview = finalPreview;
  }
}

/**
 * Raised by awaitDecision when timeout_s elapses and the action is still pending.
 * The action remains pending server-side — you may call awaitDecision again.
 */
export class ImpriTimeout extends ImpriError {
  readonly actionId: string;
  constructor(actionId: string, timeoutS: number) {
    super(
      `Timed out after ${timeoutS}s waiting for action ${actionId} — it is still pending.`,
    );
    this.name = "ImpriTimeout";
    this.actionId = actionId;
  }
}

/** Raised by verifyWebhook when the HMAC-SHA256 signature does not match. */
export class ImpriWebhookSignatureError extends ImpriError {
  constructor(message = "Webhook signature verification failed.") {
    super(message);
    this.name = "ImpriWebhookSignatureError";
  }
}
