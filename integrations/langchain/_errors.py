"""Impri exception hierarchy for the LangChain integration.

Mirrors the TypeScript error switch in mcp/src/client.ts and extends it with
402 QuotaExceeded per the API contract. All classes inherit from ImpriError
so callers can catch the entire family with a single except clause.
"""
from __future__ import annotations

from typing import Any


class ImpriError(Exception):
    """Base class for all Impri exceptions."""


class ImpriConfigError(ImpriError):
    """api_key missing at construction time, or base_url is malformed."""


class ImpriUnauthorized(ImpriError):
    """401 / 403 — missing or wrong key, or key lacks required scope."""


class ImpriNotFound(ImpriError):
    """404 — action_id or watcher_id unknown, or belongs to a different project."""


class ImpriConflict(ImpriError):
    """409 — action already decided; idempotency race; or result on non-approved action."""


class ImpriExpired(ImpriError):
    """410 / await_decision when status='expired' — approval window closed."""


class ImpriRateLimited(ImpriError):
    """429 — per-key rate limit hit (60/min writes, 300/min reads)."""

    def __init__(self, message: str, retry_after: int | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class ImpriQuotaExceeded(ImpriError):
    """402 — monthly approval limit or watcher count limit reached (cloud tiers)."""

    def __init__(self, message: str, limit: Any = None, tier: Any = None) -> None:
        super().__init__(message)
        self.limit = limit
        self.tier = tier


class ImpriValidationError(ImpriError):
    """400 / 422 — server-side schema validation failed; .issues carries Zod error array."""

    def __init__(self, message: str, issues: list[Any] | None = None) -> None:
        super().__init__(message)
        self.issues = issues or []


class ImpriApiError(ImpriError):
    """Catch-all for unexpected 4xx/5xx responses."""

    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


# ── Not HTTP errors — raised by await_decision ──────────────────────────────

class ImpriRejected(ImpriError):
    """The human reviewer rejected the action.

    This is a normal flow outcome (the reviewer said no), not an error to log
    or alert on. Catch it as a branch in your agent logic and stop the task.

    Attributes:
        action_id:     The rejected action's id.
        decision:      The full Decision dict from the API response.
        final_preview: The preview at the time of rejection (may be None).
    """

    def __init__(
        self,
        action_id: str,
        decision: dict[str, Any],
        final_preview: dict[str, Any] | None,
    ) -> None:
        super().__init__(
            f"Action {action_id!r} was rejected by a human reviewer."
        )
        self.action_id = action_id
        self.decision = decision
        self.final_preview = final_preview


class ImpriTimeout(ImpriError):
    """await_decision timed out — the action is still pending server-side.

    You may call await_decision again to keep polling, or open the inbox URL
    to check queue depth.

    Attributes:
        action_id: The action that is still pending.
    """

    def __init__(self, action_id: str) -> None:
        super().__init__(
            f"Timed out waiting for a decision on action {action_id!r}. "
            "The action is still pending — call await_decision again to resume polling."
        )
        self.action_id = action_id
