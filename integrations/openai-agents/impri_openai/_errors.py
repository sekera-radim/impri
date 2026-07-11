"""Impri exception hierarchy.

All typed exceptions inherit from ImpriError.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    import httpx


class ImpriError(Exception):
    """Base class for all Impri SDK errors."""


class ImpriConfigError(ImpriError):
    """Raised at client construction when api_key is missing or base_url is malformed."""


class ImpriUnauthorized(ImpriError):
    """Raised on HTTP 401 or 403: wrong key or missing scope."""

    def __init__(self, message: str, *, response: "httpx.Response | None" = None) -> None:
        super().__init__(message)
        self.response = response


class ImpriNotFound(ImpriError):
    """Raised on HTTP 404: action or watcher not found, or belongs to a different project."""

    def __init__(self, message: str, *, response: "httpx.Response | None" = None) -> None:
        super().__init__(message)
        self.response = response


class ImpriConflict(ImpriError):
    """Raised on HTTP 409: already decided, idempotency race, or result on non-approved action."""

    def __init__(self, message: str, *, response: "httpx.Response | None" = None) -> None:
        super().__init__(message)
        self.response = response


class ImpriExpired(ImpriError):
    """Raised on HTTP 410, or by await_decision when status='expired'.

    The approval window closed before a human decision was made.
    """

    def __init__(self, message: str, *, response: "httpx.Response | None" = None) -> None:
        super().__init__(message)
        self.response = response


class ImpriRateLimited(ImpriError):
    """Raised on HTTP 429: per-key rate limit hit."""

    def __init__(
        self,
        message: str,
        *,
        retry_after: int | None = None,
        response: "httpx.Response | None" = None,
    ) -> None:
        super().__init__(message)
        self.retry_after = retry_after
        self.response = response


class ImpriQuotaExceeded(ImpriError):
    """Raised on HTTP 402: monthly approval limit or watcher count reached (cloud tiers)."""

    def __init__(
        self,
        message: str,
        *,
        limit: int | None = None,
        tier: str | None = None,
        response: "httpx.Response | None" = None,
    ) -> None:
        super().__init__(message)
        self.limit = limit
        self.tier = tier
        self.response = response


class ImpriValidationError(ImpriError):
    """Raised on HTTP 400 or 422: server-side schema validation failed."""

    def __init__(
        self,
        message: str,
        *,
        issues: list[Any] | None = None,
        response: "httpx.Response | None" = None,
    ) -> None:
        super().__init__(message)
        self.issues: list[Any] = issues or []
        self.response = response


class ImpriApiError(ImpriError):
    """Catch-all for unexpected 4xx/5xx responses."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int,
        response: "httpx.Response | None" = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.response = response


class ImpriRejected(ImpriError):
    """Raised by await_decision when the human verdict is 'reject'.

    NOT an HTTP error — catch this as a normal flow outcome.
    The human exercised their right to say no.
    """

    def __init__(
        self,
        action_id: str,
        decision: dict[str, Any],
        final_preview: dict[str, Any],
    ) -> None:
        super().__init__(f"Action {action_id!r} was rejected by the human reviewer.")
        self.action_id = action_id
        self.decision = decision
        self.final_preview = final_preview


class ImpriTimeout(ImpriError):
    """Raised by await_decision when timeout_s elapses.

    The action remains 'pending' server-side — call await_decision again
    or poll separately.
    """

    def __init__(self, action_id: str) -> None:
        super().__init__(
            f"Timed out waiting for a decision on action {action_id!r}. "
            "The action is still pending — you can poll again."
        )
        self.action_id = action_id


class ImpriWebhookSignatureError(ImpriError):
    """Raised by verify_webhook on HMAC mismatch or bad signature format."""
