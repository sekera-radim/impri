"""Impri SDK exception hierarchy.

All exceptions inherit from ImpriError so callers can catch the base class
when they do not need to distinguish specific error types.
"""
from __future__ import annotations

from typing import Any, List, Optional


class ImpriError(Exception):
    """Base class for all Impri SDK exceptions."""


class ImpriConfigError(ImpriError):
    """Raised at client construction when api_key is missing or base_url is malformed."""


class ImpriUnauthorized(ImpriError):
    """HTTP 401/403 — missing or wrong API key, or key lacks the required scope."""

    def __init__(self, message: str, status_code: int = 401) -> None:
        super().__init__(message)
        self.status_code = status_code


class ImpriNotFound(ImpriError):
    """HTTP 404 — resource not found or belongs to a different project."""


class ImpriConflict(ImpriError):
    """HTTP 409 — action already decided, idempotency race, or result on non-approved action."""

    def __init__(self, message: str, current_status: Optional[str] = None) -> None:
        super().__init__(message)
        self.current_status = current_status


class ImpriExpired(ImpriError):
    """HTTP 410 — approval window closed.

    Also raised by await_decision when the polled action transitions to 'expired'.
    """


class ImpriRateLimited(ImpriError):
    """HTTP 429 — per-key rate limit hit.

    Check retry_after (seconds) before retrying. The write limit is 60/min;
    the read/list limit is 300/min.
    """

    def __init__(self, message: str, retry_after: Optional[int] = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class ImpriQuotaExceeded(ImpriError):
    """HTTP 402 — monthly approval limit or watcher count limit reached (cloud tiers).

    Check .limit and .tier for upgrade information.
    """

    def __init__(
        self,
        message: str,
        limit: Optional[int] = None,
        tier: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.limit = limit
        self.tier = tier


class ImpriRejected(ImpriError):
    """Raised by await_decision when a human reviewer rejected the action.

    This is NOT an error — it is a valid outcome. Catch it and handle gracefully:
    log it, notify the agent, or let the workflow branch accordingly. Do not log
    it as an unexpected error in Sentry/similar monitoring.

    Attributes:
        action_id: The ID of the rejected action.
        decision:  The full Decision dict (verdict, decided_at, channel, ...).
        final_preview: The preview dict at the time of rejection.
    """

    def __init__(self, action_id: str, decision: Any, final_preview: Any) -> None:
        super().__init__(
            f"Action {action_id!r} was rejected by a human reviewer."
        )
        self.action_id = action_id
        self.decision = decision
        self.final_preview = final_preview


class ImpriTimeout(ImpriError):
    """Raised by await_decision when timeout_s elapses with the action still pending.

    The action remains pending on the server — call await_decision again or
    poll separately. This exception does NOT mean the action expired.

    Attributes:
        action_id: The ID of the still-pending action.
    """

    def __init__(self, action_id: str) -> None:
        super().__init__(
            f"Timed out waiting for a decision on action {action_id!r}. "
            "The action is still pending on the server."
        )
        self.action_id = action_id


class ImpriValidationError(ImpriError):
    """HTTP 400/422 — server-side schema validation failed.

    Attributes:
        issues: List of Zod-format issue dicts from the server (may be empty
                when the server returns a plain 400 message instead).
    """

    def __init__(self, message: str, issues: Optional[List[Any]] = None) -> None:
        super().__init__(message)
        self.issues: List[Any] = issues or []


class ImpriApiError(ImpriError):
    """Catch-all for unexpected HTTP 4xx/5xx responses not covered by a typed exception.

    Attributes:
        status_code: The HTTP status code returned by the server.
        message:     The error message extracted from the response body.
    """

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(f"Impri API error {status_code}: {message}")
        self.status_code = status_code
        self.message = message


class ImpriWebhookSignatureError(ImpriError):
    """Webhook HMAC-SHA256 signature verification failed.

    Raised by verify_webhook() when the computed signature does not match the
    X-Impri-Signature header value.
    """
