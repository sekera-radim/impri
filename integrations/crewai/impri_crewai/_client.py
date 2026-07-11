"""Impri REST client — stdlib only (no dependency on sdk/python).

Covers the action lifecycle and the await_decision polling loop that every
CrewAI integration needs. Watcher and admin endpoints are omitted here; use
the full Python SDK if you need them.

Configuration (priority order):
  1. Constructor keyword arguments api_key / base_url
  2. Environment variables IMPRI_API_KEY / IMPRI_BASE_URL
  3. Default base_url: http://localhost:8484 (self-hosted)
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import urllib.parse
from typing import Any, Dict, List, Literal, Optional, Tuple

from ._exceptions import (
    ImpriApiError,
    ImpriConfigError,
    ImpriConflict,
    ImpriExpired,
    ImpriNotFound,
    ImpriQuotaExceeded,
    ImpriRateLimited,
    ImpriRejected,
    ImpriTimeout,
    ImpriUnauthorized,
    ImpriValidationError,
    ImpriWebhookSignatureError,
)
from ._transport import Transport, urllib_transport

_DEFAULT_BASE_URL = "http://localhost:8484"
_MIN_POLL_INTERVAL = 5.0  # seconds — floor recommended by the API spec


class ImpriClient:
    """Minimal Impri HTTP client covering the action lifecycle.

    Args:
        api_key:    Impri API key (im_...). Falls back to IMPRI_API_KEY env var.
        base_url:   Base URL without /v1. Falls back to IMPRI_BASE_URL, then
                    http://localhost:8484. Trailing slash is tolerated.
        _transport: Injectable transport callable for testing. Signature:
                    (method, url, headers, body_bytes) → (status_code, body_bytes).
                    Defaults to the stdlib urllib transport.
    """

    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        _transport: Optional[Transport] = None,
    ) -> None:
        key = api_key or os.environ.get("IMPRI_API_KEY")
        if not key:
            raise ImpriConfigError(
                "No API key provided. Pass api_key= or set IMPRI_API_KEY."
            )
        self._api_key = key

        raw_base = (
            base_url
            or os.environ.get("IMPRI_BASE_URL")
            or _DEFAULT_BASE_URL
        )
        self._base_url = raw_base.rstrip("/")
        self._transport: Transport = _transport or urllib_transport

    # ------------------------------------------------------------------ #
    # Internal HTTP layer                                                  #
    # ------------------------------------------------------------------ #

    def _request(self, method: str, path: str, body: Any = None) -> Any:
        url = f"{self._base_url}/v1{path}"
        headers: Dict[str, str] = {
            "Authorization": f"Bearer {self._api_key}",
            "Accept": "application/json",
        }
        body_bytes: Optional[bytes] = None
        if body is not None:
            body_bytes = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"

        status, raw = self._transport(method, url, headers, body_bytes)

        if status == 204:
            return {}
        if status < 400:
            return json.loads(raw)

        self._raise_for_status(status, raw)

    @staticmethod
    def _raise_for_status(status: int, raw: bytes) -> None:
        try:
            body: Dict[str, Any] = json.loads(raw)
            detail: str = body.get("message") or body.get("error") or ""
            issues = body.get("issues")
            quota_limit: Optional[int] = body.get("limit")
            quota_tier: Optional[str] = body.get("tier")
        except Exception:
            body = {}
            detail = raw.decode(errors="replace")
            issues = None
            quota_limit = None
            quota_tier = None

        if status in (401, 403):
            raise ImpriUnauthorized(
                "Authentication failed — verify IMPRI_API_KEY is correct "
                "and has the required scope (needs 'actions').",
                status_code=status,
            )
        if status == 402:
            raise ImpriQuotaExceeded(
                detail or "Monthly quota or watcher count limit reached.",
                limit=quota_limit,
                tier=quota_tier,
            )
        if status == 404:
            raise ImpriNotFound(
                "Resource not found — verify the action_id belongs to this project."
            )
        if status == 409:
            raise ImpriConflict(
                "Conflict — action already decided or idempotency race."
            )
        if status == 410:
            raise ImpriExpired(
                "Action expired — the approval window has closed."
            )
        if status in (400, 422):
            raise ImpriValidationError(
                f"Invalid request: {detail or 'check the parameters.'}",
                issues=issues,
            )
        if status == 429:
            raise ImpriRateLimited(
                "Rate limit reached — wait a moment and retry."
            )
        raise ImpriApiError(status, detail or "unexpected server error")

    # ------------------------------------------------------------------ #
    # Actions                                                              #
    # ------------------------------------------------------------------ #

    def create_action(
        self,
        kind: str,
        title: str,
        preview: Dict[str, str],
        *,
        payload: Any = None,
        target_url: Optional[str] = None,
        callback_url: Optional[str] = None,
        expires_in: int = 259200,
        idempotency_key: Optional[str] = None,
        editable: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """POST /v1/actions — submit an action for human approval.

        Returns the ActionCreated dict (201 on new, 200 on idempotency/content
        duplicate). Check .duplicate_of to distinguish.
        """
        body: Dict[str, Any] = {
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

    def get_action(self, action_id: str) -> Dict[str, Any]:
        """GET /v1/actions/:id — fetch action with its current decision."""
        return self._request("GET", f"/actions/{action_id}")  # type: ignore[return-value]

    def list_actions(
        self,
        *,
        status: Optional[str] = None,
        kind: Optional[str] = None,
        since: Optional[int] = None,
        limit: int = 50,
        cursor: Optional[str] = None,
    ) -> Dict[str, Any]:
        """GET /v1/actions — cursor-paginated list (newest first)."""
        params: Dict[str, Any] = {"limit": limit}
        if status:
            params["status"] = status
        if kind:
            params["kind"] = kind
        if since:
            params["since"] = since
        if cursor:
            params["cursor"] = cursor
        qs = "?" + urllib.parse.urlencode(params)
        return self._request("GET", f"/actions{qs}")  # type: ignore[return-value]

    def report_result(
        self,
        action_id: str,
        status: Literal["executed", "execute_failed"],
        *,
        detail: Optional[str] = None,
    ) -> Dict[str, Any]:
        """POST /v1/actions/:id/result — report execution outcome.

        Call this after executing an approved action. Only valid when the
        action is in 'approved' state; raises ImpriConflict otherwise.
        """
        body: Dict[str, Any] = {"status": status}
        if detail is not None:
            body["detail"] = detail
        return self._request("POST", f"/actions/{action_id}/result", body)  # type: ignore[return-value]

    # ------------------------------------------------------------------ #
    # Polling loop                                                         #
    # ------------------------------------------------------------------ #

    def await_decision(
        self,
        action_id: str,
        *,
        timeout_s: float = 300.0,
        poll_interval_s: float = 5.0,
    ) -> Dict[str, Any]:
        """Poll GET /v1/actions/:id until the action leaves 'pending'.

        Returns the full Action dict on approval.
        Raises ImpriRejected when the human rejects (not an error — handle it).
        Raises ImpriExpired when the approval window closes.
        Raises ImpriTimeout when timeout_s elapses with action still pending.

        The polling floor is 5 s per the API spec (rate limit: 300 GET/min).
        """
        deadline = time.monotonic() + timeout_s
        interval = max(poll_interval_s, _MIN_POLL_INTERVAL)

        while True:
            action = self.get_action(action_id)
            action_status = action.get("status")

            if action_status == "approved":
                return action
            if action_status == "rejected":
                decision = action.get("decision") or {}
                final_preview = decision.get("final_preview") or action.get("preview") or {}
                raise ImpriRejected(action_id, decision, final_preview)
            if action_status == "expired":
                raise ImpriExpired(
                    f"Action {action_id!r} expired before a human could decide."
                )

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ImpriTimeout(action_id)

            time.sleep(min(interval, remaining))


# ------------------------------------------------------------------ #
# Standalone webhook verification helper                              #
# ------------------------------------------------------------------ #

def verify_webhook(
    raw_body: bytes,
    secret: str,
    timestamp: str,
    nonce: str,
    signature: str,
    tolerance_sec: int = 300,
) -> None:
    """Verify an Impri webhook X-Impri-Signature header.

    Algorithm: sha256=HMAC-SHA256(secret, f'{timestamp}.{nonce}.{rawBody}')

    Args:
        raw_body:      The unread request body bytes (do not decode first).
        secret:        The webhook_secret from GET /v1/project.
        timestamp:     Value of the X-Impri-Timestamp request header.
        nonce:         Value of the X-Impri-Nonce request header.
        signature:     Value of the X-Impri-Signature request header.
        tolerance_sec: Maximum age of the webhook in seconds (default 300).
                       Deliveries older than this window are rejected as
                       potential replays.

    Raises:
        ImpriWebhookSignatureError: If the computed digest does not match or
            the timestamp is outside the tolerance window.
    """
    # Replay-protection: reject deliveries outside the tolerance window.
    try:
        ts = int(timestamp)
    except (ValueError, TypeError):
        raise ImpriWebhookSignatureError(
            "X-Impri-Timestamp is missing or not a valid integer."
        )
    if abs(time.time() - ts) > tolerance_sec:
        raise ImpriWebhookSignatureError(
            f"Webhook timestamp is outside the {tolerance_sec}s tolerance window "
            "(replay protection). Ensure your server clock is synced."
        )

    message = f"{timestamp}.{nonce}.".encode() + raw_body
    expected = "sha256=" + hmac.new(
        secret.encode(), message, hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise ImpriWebhookSignatureError(
            "Webhook signature mismatch — check your webhook_secret and "
            "that you are passing the raw (un-decoded) request body."
        )
