"""Impri REST client — Python stdlib only.

No third-party dependencies. Uses urllib.request (blocking I/O) and mirrors
the polling logic in mcp/src/tools.ts (awaitDecision) and the error-handling
switch in mcp/src/client.ts (throwApiError), extended with 402 QuotaExceeded.

Base URL resolution order:
  1. ``base_url`` constructor argument
  2. ``IMPRI_BASE_URL`` environment variable
  3. ``http://localhost:8484`` (self-hosted default)

The client always appends ``/v1`` internally; callers never include it in the
base URL. Trailing slashes on the base URL are stripped silently.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any

from ._errors import (
    ImpriApiError,
    ImpriConflict,
    ImpriConfigError,
    ImpriExpired,
    ImpriNotFound,
    ImpriQuotaExceeded,
    ImpriRateLimited,
    ImpriRejected,
    ImpriTimeout,
    ImpriUnauthorized,
    ImpriValidationError,
)


class ImpriClient:
    """Synchronous Impri REST client backed by ``urllib.request``.

    Args:
        api_key:  Bearer token (``im_...``). Falls back to ``IMPRI_API_KEY`` env var.
        base_url: API root without the ``/v1`` path prefix. Falls back to
                  ``IMPRI_BASE_URL``, then ``http://localhost:8484``.

    Raises:
        ImpriConfigError: if neither ``api_key`` nor ``IMPRI_API_KEY`` is set.

    Example::

        client = ImpriClient(api_key="im_...")
        action = client.create_action(
            kind="email.send",
            title="Send welcome email to alice@example.com",
            preview={"format": "plain", "body": "Hello, welcome!"},
        )
        approved = client.await_decision(action["id"])
        # ... execute the action ...
        client.report_result(action["id"], "executed")
    """

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
    ) -> None:
        resolved_key = api_key or os.environ.get("IMPRI_API_KEY")
        if not resolved_key:
            raise ImpriConfigError(
                "No API key found. Pass api_key= or set the IMPRI_API_KEY "
                "environment variable."
            )
        self._api_key = resolved_key

        resolved_url = (
            base_url
            or os.environ.get("IMPRI_BASE_URL")
            or "http://localhost:8484"
        )
        self._base = resolved_url.rstrip("/") + "/v1"

    # ── Low-level HTTP ───────────────────────────────────────────────────────

    def _request(self, method: str, path: str, body: Any = None) -> Any:
        """Make an authenticated JSON request and return the parsed response body.

        Raises the appropriate ``ImpriError`` subclass on non-2xx responses.
        """
        url = self._base + path
        headers: dict[str, str] = {
            "Authorization": f"Bearer {self._api_key}",
            "Accept": "application/json",
        }
        data: bytes | None = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode()
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            return self._raise_http_error(exc)

    def _raise_http_error(self, exc: urllib.error.HTTPError) -> Any:
        """Map HTTP error codes to typed ImpriError subclasses."""
        try:
            body: dict[str, Any] = json.loads(exc.read())
        except Exception:
            body = {}

        detail: str = body.get("message") or body.get("error") or exc.reason or ""
        status = exc.code

        if status in (401, 403):
            raise ImpriUnauthorized(
                "Authentication failed — verify your IMPRI_API_KEY is correct "
                "and has the required scope ('actions' for action operations)."
            )
        if status == 402:
            raise ImpriQuotaExceeded(
                f"Quota exceeded: {detail or 'monthly approval limit reached.'}",
                limit=body.get("limit"),
                tier=body.get("tier"),
            )
        if status == 404:
            raise ImpriNotFound(
                "Resource not found — verify the action_id is correct and "
                "belongs to this API key's project."
            )
        if status == 409:
            raise ImpriConflict(
                "Conflict — the action has already been decided, or a concurrent "
                "idempotency race occurred. Use get_action to check current status."
            )
        if status == 410:
            raise ImpriExpired(
                "Action expired — the approval window has closed. "
                "Create a new action if the task is still relevant."
            )
        if status in (400, 422):
            raise ImpriValidationError(
                f"Invalid request: {detail or 'check the parameters and try again.'}",
                issues=body.get("issues"),
            )
        if status == 429:
            ra_raw = exc.headers.get("Retry-After") if exc.headers else None
            retry_after = (
                int(ra_raw) if ra_raw and str(ra_raw).strip().isdigit() else None
            )
            raise ImpriRateLimited(
                "Rate limit reached — wait a moment and retry.",
                retry_after=retry_after,
            )
        raise ImpriApiError(
            f"Impri API error {status}: {detail or exc.reason}",
            status_code=status,
        )

    # ── Actions ──────────────────────────────────────────────────────────────

    def create_action(
        self,
        kind: str,
        title: str,
        preview: dict[str, str],
        *,
        payload: Any = None,
        target_url: str | None = None,
        callback_url: str | None = None,
        expires_in: int = 259200,
        idempotency_key: str | None = None,
        editable: list[str] | None = None,
    ) -> dict[str, Any]:
        """POST /v1/actions — submit an action for human approval.

        Args:
            kind:            Taxonomy label for inbox filtering (e.g. ``'email.send'``).
            title:           Short headline shown on the inbox card (max 120 chars).
            preview:         ``{"format": "markdown"|"plain"|"diff", "body": str}``.
            payload:         Opaque data echoed back in webhook/decision; not shown to reviewer.
            target_url:      URL the reviewer can open for context.
            callback_url:    Webhook URL for decision notifications.
            expires_in:      Seconds until auto-expiry (300–2592000, default 259200 = 72 h).
            idempotency_key: Stable key to prevent duplicate submissions on retry.
            editable:        Dot-path fields the reviewer may edit (e.g. ``['preview.body']``).

        Returns:
            ActionCreated dict: ``{id, status, inbox_url, expires_at, created_at, duplicate_of?}``
        """
        body: dict[str, Any] = {
            "kind": kind,
            "title": title,
            "preview": preview,
            "expires_in": expires_in,
        }
        if payload is not None:
            body["payload"] = payload
        if target_url is not None:
            body["target_url"] = target_url
        if callback_url is not None:
            body["callback_url"] = callback_url
        if idempotency_key is not None:
            body["idempotency_key"] = idempotency_key
        if editable is not None:
            body["editable"] = editable
        return self._request("POST", "/actions", body)  # type: ignore[return-value]

    def get_action(self, action_id: str) -> dict[str, Any]:
        """GET /v1/actions/:id — fetch a single action with its current status.

        The ``decision`` field is present only after a human has acted. Use
        ``decision.final_preview`` for execution when editable fields may have
        been modified by the reviewer.

        Raises:
            ImpriNotFound: if the action_id is unknown or belongs to another project.
        """
        return self._request("GET", f"/actions/{action_id}")  # type: ignore[return-value]

    def report_result(
        self,
        action_id: str,
        status: str,
        *,
        detail: str | None = None,
    ) -> dict[str, Any]:
        """POST /v1/actions/:id/result — report execution outcome after approval.

        Always call this after attempting an approved action so the inbox shows
        the closed audit loop. ``status`` must be ``'executed'`` or
        ``'execute_failed'``.

        Raises:
            ImpriConflict: if the action is not in the ``'approved'`` state.
        """
        body: dict[str, Any] = {"status": status}
        if detail is not None:
            body["detail"] = detail
        return self._request("POST", f"/actions/{action_id}/result", body)  # type: ignore[return-value]

    def await_decision(
        self,
        action_id: str,
        *,
        timeout_s: float = 300.0,
        poll_interval_s: float = 5.0,
    ) -> dict[str, Any]:
        """Poll GET /v1/actions/:id until the action leaves the 'pending' state.

        On approval, returns the full Action dict. Use ``action["decision"]["final_preview"]``
        for execution when ``editable`` fields may have been changed by the reviewer.

        Args:
            action_id:      The action to poll.
            timeout_s:      Maximum seconds to wait (default 300). The action remains
                            pending server-side after a timeout — call again to resume.
            poll_interval_s: Seconds between polls (minimum recommended: 5 s).

        Returns:
            The approved Action dict.

        Raises:
            ImpriRejected:  Human rejected — carry this as a normal flow outcome,
                            not an error. The agent should stop and not execute.
            ImpriExpired:   Approval window closed before a decision was made.
            ImpriTimeout:   timeout_s elapsed; action is still pending server-side.
        """
        deadline = time.monotonic() + timeout_s
        while True:
            action = self.get_action(action_id)
            status = action.get("status", "pending")

            if status != "pending":
                if status == "rejected":
                    decision = action.get("decision") or {}
                    raise ImpriRejected(
                        action_id,
                        decision=decision,
                        final_preview=decision.get("final_preview"),
                    )
                if status == "expired":
                    raise ImpriExpired(
                        f"Action {action_id!r} expired before a human decision was made."
                    )
                # approved / executed / execute_failed — return as success path
                return action

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ImpriTimeout(action_id)

            time.sleep(min(poll_interval_s, remaining))
