"""Impri exception hierarchy for the CrewAI integration.

Mirrors the canonical exception hierarchy from docs/llms.txt. Intentionally
self-contained — no imports from sdk/python so this package stands alone.
"""
from __future__ import annotations

from typing import Any, List, Optional


class ImpriError(Exception):
    """Base class for all Impri exceptions."""


class ImpriConfigError(ImpriError):
    """API key missing at construction time, or base_url is malformed."""


class ImpriUnauthorized(ImpriError):
    """HTTP 401/403 — missing or wrong key, or key lacks the required scope."""

    def __init__(self, message: str, status_code: int = 401) -> None:
        super().__init__(message)
        self.status_code = status_code


class ImpriNotFound(ImpriError):
    """HTTP 404 — action_id unknown or belongs to a different project."""


class ImpriConflict(ImpriError):
    """HTTP 409 — action already decided, idempotency race, or result on non-approved action."""

    def __init__(self, message: str, current_status: Optional[str] = None) -> None:
        super().__init__(message)
        self.current_status = current_status


class ImpriExpired(ImpriError):
    """HTTP 410 / status='expired' — approval window closed before a human decided."""


class ImpriRateLimited(ImpriError):
    """HTTP 429 — per-key rate limit hit (60/min writes, 300/min reads).

    Attributes:
        retry_after: Seconds to wait before retrying, when the server provides it.
    """

    def __init__(self, message: str, retry_after: Optional[int] = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class ImpriQuotaExceeded(ImpriError):
    """HTTP 402 — monthly approval or watcher count limit reached (cloud tiers).

    Attributes:
        limit: The tier's limit that was reached.
        tier:  The current billing tier name.
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

    This is NOT an error — it is a valid, expected outcome. Catch it and handle
    it as a normal flow branch (log, notify, move on). Do not log it as an
    unexpected exception in Sentry or similar monitoring.

    Attributes:
        action_id:     The ID of the rejected action.
        decision:      The full Decision dict from the API response.
        final_preview: The preview at the time of rejection.
    """

    def __init__(self, action_id: str, decision: Any, final_preview: Any) -> None:
        super().__init__(f"Action {action_id!r} was rejected by a human reviewer.")
        self.action_id = action_id
        self.decision = decision
        self.final_preview = final_preview


class ImpriTimeout(ImpriError):
    """Raised by await_decision when timeout_s elapses with action still pending.

    The action remains pending on the server — call await_decision again to keep
    waiting, or poll separately. This is NOT the same as the action expiring.

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
        issues: List of Zod-format issue dicts from the server response.
    """

    def __init__(self, message: str, issues: Optional[List[Any]] = None) -> None:
        super().__init__(message)
        self.issues: List[Any] = issues or []


class ImpriApiError(ImpriError):
    """Catch-all for unexpected HTTP 4xx/5xx responses.

    Attributes:
        status_code: The HTTP status code.
        message:     Error message extracted from the response body.
    """

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(f"Impri API error {status_code}: {message}")
        self.status_code = status_code
        self.message = message


class ImpriWebhookSignatureError(ImpriError):
    """Webhook HMAC-SHA256 signature verification failed.

    Raised by verify_webhook() when the computed digest does not match the
    X-Impri-Signature header value.
    """
