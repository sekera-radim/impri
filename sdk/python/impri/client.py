"""Impri Python SDK — ImpriClient and ergonomic helpers.

Sync client. Zero third-party dependencies; uses stdlib urllib for HTTP.
Pass a custom _transport callable for testing (see tests/).

Quick start:
    from impri import ImpriClient
    client = ImpriClient()          # reads IMPRI_API_KEY from env
    action = client.create_action(
        kind="email.send",
        title="Send weekly digest to alice@example.com",
        preview={"format": "plain", "body": "Hi Alice, ..."},
        editable=["preview.body"],
    )
    approved = client.await_decision(action["id"])
    client.report_result(action["id"], "executed")
"""
from __future__ import annotations

import functools
import hashlib
import hmac
import inspect
import json
import os
import time
import urllib.parse
import warnings
from contextlib import contextmanager
from typing import Any, Callable, Dict, Generator, Iterator, List, Literal, Optional, Tuple

from ._transport import urllib_transport
from .errors import (
    ImpriApiError,
    ImpriConfigError,
    ImpriConflict,
    ImpriError,
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
from .models import (
    Action,
    ActionCreated,
    ActionStatus,
    ApiKey,
    ApiKeyCreated,
    ApprovedAction,
    BulkDecisionRequest,
    BulkDecisionResponse,
    BulkDecisionResult,
    DecisionResult,
    PagedResult,
    Preview,
    Project,
    ProjectExport,
    ResultAck,
    ScoringRule,
    Watcher,
    WatcherConfig,
    WatcherKind,
    WatcherPreset,
    WatcherPresetList,
    WatcherSchedule,
)

# Default self-hosted URL — callers set IMPRI_BASE_URL or pass base_url for cloud.
_DEFAULT_BASE_URL = "http://localhost:8484"


def _auto_idempotency_key(kind: str, title: str, preview_body: str) -> str:
    """Stable per-task idempotency key so retried calls deduplicate automatically.

    Stability scope: same (process, UTC day, kind, title, preview body).
    A different day bucket ensures that genuinely new actions on the same content
    (e.g. a daily digest) are not silently swallowed.
    """
    day_bucket = int(time.time()) // 86400
    content = f"{os.getpid()}:{day_bucket}:{kind}:{title}:{preview_body}"
    digest = hashlib.sha256(content.encode()).hexdigest()[:32]
    return f"sdk_{digest}"


def _raise_for_status(status: int, body: Any) -> None:
    """Map HTTP status codes to typed Impri exceptions."""
    message: str = ""
    if isinstance(body, dict):
        message = body.get("message") or body.get("error") or ""

    if status in (401, 403):
        raise ImpriUnauthorized(
            message or "Authentication failed — verify your API key and its scope.",
            status_code=status,
        )
    if status == 402:
        raise ImpriQuotaExceeded(
            message or "Monthly quota or watcher limit reached.",
            limit=body.get("limit") if isinstance(body, dict) else None,
            tier=body.get("tier") if isinstance(body, dict) else None,
        )
    if status == 404:
        raise ImpriNotFound(
            message or "Resource not found or belongs to a different project."
        )
    if status == 409:
        raise ImpriConflict(
            message or "Conflict — action already decided or concurrent writer.",
            current_status=body.get("current_status") if isinstance(body, dict) else None,
        )
    if status == 410:
        raise ImpriExpired(
            message or "Approval window has closed."
        )
    if status == 429:
        retry_after: Optional[int] = None
        if isinstance(body, dict) and "retry_after" in body:
            retry_after = int(body["retry_after"])
        raise ImpriRateLimited(
            message or "Rate limit hit — reduce request frequency.",
            retry_after=retry_after,
        )
    if status in (400, 422):
        issues = body.get("issues") if isinstance(body, dict) else None
        raise ImpriValidationError(
            message or f"Validation error (HTTP {status}).",
            issues=issues,
        )
    raise ImpriApiError(status, message or "Unexpected API error.")


def _deserialize_action(data: Dict[str, Any]) -> Action:
    """Post-process a raw action dict from the API.

    Adds the computed is_untrusted flag: True when payload.untrusted is truthy
    (items delivered by a Watcher). Callers must treat such actions' title/
    preview/url as untrusted external data, never as LLM instructions.
    """
    payload = data.get("payload")
    is_untrusted = bool(
        isinstance(payload, dict) and payload.get("untrusted")
    )
    return {**data, "is_untrusted": is_untrusted}  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Webhook verification (standalone — no client instance required)
# ---------------------------------------------------------------------------

def verify_webhook(
    raw_body: bytes,
    secret: str,
    timestamp: str,
    nonce: str,
    signature: str,
    tolerance_sec: int = 300,
) -> None:
    """Verify an Impri webhook delivery signature.

    Algorithm: ``sha256=HMAC-SHA256(secret, f'{timestamp}.{nonce}.{raw_body}')``

    Pass the raw (undecoded) request body and the values of the HTTP headers
    X-Impri-Timestamp, X-Impri-Nonce, and X-Impri-Signature.

    Raises ImpriWebhookSignatureError on mismatch, staleness, or missing data;
    returns None on success.

    Usage::

        @app.route("/webhook", methods=["POST"])
        def handle_webhook():
            impri.verify_webhook(
                request.data,
                secret=os.environ["WEBHOOK_SECRET"],
                timestamp=request.headers["X-Impri-Timestamp"],
                nonce=request.headers["X-Impri-Nonce"],
                signature=request.headers["X-Impri-Signature"],
            )
            payload = request.json
            ...
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
    computed = "sha256=" + hmac.new(
        secret.encode(), message, "sha256"
    ).hexdigest()
    if not hmac.compare_digest(computed, signature):
        raise ImpriWebhookSignatureError(
            "Webhook signature mismatch — check your WEBHOOK_SECRET and that you "
            "are passing the raw (undecoded) request body."
        )


# ---------------------------------------------------------------------------
# ImpriClient
# ---------------------------------------------------------------------------

class ImpriClient:
    """Synchronous Impri API client.

    Args:
        api_key:   Bearer token (``im_...``). Falls back to ``IMPRI_API_KEY`` env var.
                   Raises ImpriConfigError if neither is set.
        base_url:  Server root URL (no trailing slash, no ``/v1``).
                   Falls back to ``IMPRI_BASE_URL``, then ``http://localhost:8484``.
        _transport: Callable ``(method, url, headers, body) -> (status, bytes)``
                    injected in tests to avoid real HTTP calls.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        base_url: Optional[str] = None,
        _transport: Optional[Callable] = None,
    ) -> None:
        resolved_key = api_key or os.environ.get("IMPRI_API_KEY")
        if not resolved_key:
            raise ImpriConfigError(
                "No API key provided. Pass api_key= or set the IMPRI_API_KEY "
                "environment variable."
            )
        self._api_key = resolved_key

        raw_url = (
            base_url
            or os.environ.get("IMPRI_BASE_URL")
            or _DEFAULT_BASE_URL
        )
        self._base_url = raw_url.rstrip("/")

        self._transport = _transport or urllib_transport

    # ------------------------------------------------------------------
    # Internal HTTP helpers
    # ------------------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        params: Optional[Dict[str, Any]] = None,
    ) -> Any:
        """Make an authenticated API request and return the parsed JSON body.

        Returns None for 204 No Content. Raises a typed ImpriError subclass
        for all error responses.
        """
        url = f"{self._base_url}/v1{path}"
        if params:
            filtered = {k: v for k, v in params.items() if v is not None}
            if filtered:
                url += "?" + urllib.parse.urlencode(filtered)

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
            return None

        parsed: Any = None
        if raw:
            try:
                parsed = json.loads(raw.decode())
            except (json.JSONDecodeError, UnicodeDecodeError):
                parsed = {}

        if status >= 400:
            _raise_for_status(status, parsed)

        return parsed

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------

    def create_action(
        self,
        kind: str,
        title: str,
        preview: Preview,
        *,
        payload: Any = None,
        target_url: Optional[str] = None,
        callback_url: Optional[str] = None,
        expires_in: int = 259200,
        idempotency_key: Optional[str] = None,
        editable: List[str] = [],
    ) -> ActionCreated:
        """Submit an action for human approval.

        POST /v1/actions (requires 'actions' scope).

        Returns HTTP 201 for new actions, 200 when an idempotency_key or
        content duplicate (same kind+title+preview) is found. Check
        ``.duplicate_of`` on the returned dict to distinguish.

        Args:
            kind:            Free-form action taxonomy, e.g. ``"email.send"``.
            title:           Human-readable title (no newlines; max 500 chars).
            preview:         ``{"format": "plain"|"markdown"|"diff", "body": "..."}``.
                             body max 256 KB.
            payload:         Opaque dict stored and returned in callbacks.
            target_url:      Link shown to the reviewer (http/https only).
            callback_url:    Webhook URL for decision delivery (http/https only).
            expires_in:      Seconds until the action expires (300–2592000; default 72 h).
            idempotency_key: Deduplication key (max 255 chars). When omitted, the SDK
                             generates a stable key from (pid, day, kind, title, preview.body)
                             so retried calls within the same task deduplicate automatically.
            editable:        Dot-path list of fields the reviewer may modify before approving
                             (e.g. ``["preview.body"]``).
        """
        if idempotency_key is None:
            idempotency_key = _auto_idempotency_key(
                kind, title, preview.get("body", "")
            )

        req_body: Dict[str, Any] = {
            "kind": kind,
            "title": title,
            "preview": preview,
            "expires_in": expires_in,
            "editable": editable,
            "idempotency_key": idempotency_key,
        }
        if payload is not None:
            req_body["payload"] = payload
        if target_url is not None:
            req_body["target_url"] = target_url
        if callback_url is not None:
            req_body["callback_url"] = callback_url

        return self._request("POST", "/actions", body=req_body)  # type: ignore[return-value]

    def get_action(self, action_id: str) -> Action:
        """Fetch a single action with its current status and decision.

        GET /v1/actions/:id (requires 'actions' scope).

        The ``decision`` field is present only after a human has approved or
        rejected. Use ``decision["final_preview"]`` for execution when editable
        fields may have been modified by the reviewer.
        """
        data = self._request("GET", f"/actions/{action_id}")
        return _deserialize_action(data)

    def list_actions(
        self,
        *,
        status: Optional[str] = None,
        kind: Optional[str] = None,
        since: Optional[int] = None,
        q: Optional[str] = None,
        limit: int = 50,
        cursor: Optional[str] = None,
    ) -> PagedResult:
        """List actions for the project, newest first.

        GET /v1/actions (requires 'actions' scope).

        Args:
            status: Filter by action status (e.g. ``"pending"``).
            kind:   Filter by kind string (exact match).
            since:  Unix timestamp — only actions created at or after this time.
            q:      Free-text search over action title and preview body (max 200
                    chars). Matched using SQL LIKE against title and
                    ``preview.body``; case-insensitive on most deployments.
            limit:  Page size (1–100; default 50).
            cursor: Opaque cursor from ``next_cursor`` for pagination.

        Returns a PagedResult with ``items``, ``has_more``, and ``next_cursor``.
        Call iter_actions() for automatic pagination.
        """
        data = self._request(
            "GET",
            "/actions",
            params={
                "status": status,
                "kind": kind,
                "since": since,
                "q": q,
                "limit": limit,
                "cursor": cursor,
            },
        )
        items = [_deserialize_action(a) for a in data.get("items", [])]
        return {**data, "items": items}  # type: ignore[return-value]

    def iter_actions(
        self,
        *,
        status: Optional[str] = None,
        kind: Optional[str] = None,
        since: Optional[int] = None,
        q: Optional[str] = None,
        limit: int = 50,
    ) -> Iterator[Action]:
        """Auto-paginating iterator over all matching actions.

        Transparently fetches subsequent pages using next_cursor until has_more
        is False. Each yielded item is a fully deserialized Action dict.

        Args:
            status: Filter by action status.
            kind:   Filter by kind string.
            since:  Unix timestamp lower bound.
            q:      Free-text search (title + preview body).
            limit:  Page size per fetch (1–100; default 50).

        Usage::

            for action in client.iter_actions(status="pending"):
                print(action["id"], action["title"])
        """
        cursor: Optional[str] = None
        while True:
            page = self.list_actions(
                status=status, kind=kind, since=since, q=q, limit=limit, cursor=cursor
            )
            yield from page.get("items", [])
            if not page.get("has_more"):
                break
            cursor = page.get("next_cursor")

    def decide(
        self,
        action_id: str,
        verdict: Literal["approve", "reject"],
        *,
        edited: Optional[Dict[str, Any]] = None,
        channel: Optional[str] = None,
    ) -> DecisionResult:
        """Record a human decision (approve or reject) on an action.

        POST /v1/actions/:id/decision (requires 'actions' scope).

        Primarily used by the web inbox; SDKs expose it for programmatic
        approvals or rejection scripts.

        Args:
            action_id: ID of the action to decide.
            verdict:   ``"approve"`` or ``"reject"``.
            edited:    Dot-path overrides restricted to the action's editable
                       whitelist (e.g. ``{"preview.body": "revised text"}``).
                       Unknown keys return 422.
            channel:   Identifies the decision channel in the audit log.

        Raises ImpriConflict (409) if the action is already decided.
        Raises ImpriNotFound (404) if action_id is unknown or wrong project.
        """
        req_body: Dict[str, Any] = {"decision": verdict}
        if edited is not None:
            req_body["edited"] = edited
        if channel is not None:
            req_body["channel"] = channel
        return self._request("POST", f"/actions/{action_id}/decision", body=req_body)  # type: ignore[return-value]

    def bulk_decide(
        self,
        ids: List[str],
        verdict: Literal["approve", "reject"],
        *,
        comment: Optional[str] = None,
    ) -> BulkDecisionResponse:
        """Submit the same approve/reject verdict for multiple actions at once.

        POST /v1/actions/bulk-decision (requires 'actions' scope).

        Rate limit: 10 requests/min per key.  Each request can cover up to 50
        action IDs, giving an effective ceiling of 500 decisions/min.

        The server processes each item independently — a failure on one ID does
        NOT roll back successes on others.  HTTP 200 is returned even when some
        items fail; inspect each ``BulkDecisionResult`` individually.

        Args:
            ids:     1–50 action IDs to decide.  Duplicates are deduplicated
                     server-side.
            verdict: ``"approve"`` or ``"reject"`` — applied to every ID.
            comment: Optional comment stored with each decision (max 500 chars).
                     Applied uniformly; per-item comments are not supported.

        Returns a BulkDecisionResponse:
            ``results``   — one entry per input ID.
            ``succeeded`` — count of items where ``ok=True``.
            ``failed``    — count of items where ``ok=False``.

        Per-item error values in result["error"]:
            ``"not_found"``       — ID unknown or belongs to a different project.
            ``"already_decided"`` — action is not pending; ``current_status`` provided.
            ``"internal"``        — unexpected server error (logged server-side).

        Raises:
            ImpriValidationError (400) — ``ids`` empty, exceeds 50, or
                                          ``verdict`` not in ``{"approve","reject"}``.
            ImpriUnauthorized (401/403) — key lacks the ``"actions"`` scope.
            ImpriRateLimited (429)      — bulk rate limit (10/min) exhausted.

        Note:
            Actions with non-empty ``editable`` lists must be decided via
            :meth:`decide` so per-item edits pass whitelist validation.
            The bulk endpoint intentionally omits the ``edited`` field.

        Usage::

            resp = client.bulk_decide(["act_1", "act_2", "act_3"], "approve",
                                      comment="Batch approved by review script")
            print(f"Succeeded: {resp['succeeded']}, failed: {resp['failed']}")
            for r in resp["results"]:
                if not r["ok"]:
                    print(f"  {r['id']}: {r['error']}")
        """
        req_body: Dict[str, Any] = {
            "ids": ids,
            "verdict": verdict,
        }
        if comment is not None:
            req_body["comment"] = comment
        return self._request("POST", "/actions/bulk-decision", body=req_body)  # type: ignore[return-value]

    def report_result(
        self,
        action_id: str,
        status: Literal["executed", "execute_failed"],
        *,
        detail: Optional[str] = None,
    ) -> ResultAck:
        """Report execution outcome after an approved action has been executed.

        POST /v1/actions/:id/result (requires 'actions' scope).

        Call this after executing an approved action to transition the state to
        ``"executed"`` or ``"execute_failed"``.

        Args:
            action_id: ID of the approved action.
            status:    ``"executed"`` on success, ``"execute_failed"`` on failure.
            detail:    Optional free-form string (e.g. error message or HTTP status).

        Raises ImpriConflict (409) if the action is not in ``"approved"`` state.
        """
        req_body: Dict[str, Any] = {"status": status}
        if detail is not None:
            req_body["detail"] = detail
        return self._request("POST", f"/actions/{action_id}/result", body=req_body)  # type: ignore[return-value]

    def await_decision(
        self,
        action_id: str,
        *,
        timeout_s: float = 300,
        poll_interval_s: float = 5,
    ) -> Action:
        """Poll until the action leaves the 'pending' state.

        Not a separate HTTP endpoint — calls GET /v1/actions/:id every
        poll_interval_s seconds (minimum recommended 5 s; rate limit 300/min).

        Args:
            action_id:      ID of the pending action to poll.
            timeout_s:      Maximum seconds to wait (default 300 / 5 min).
                            After this the action remains pending server-side.
            poll_interval_s: Seconds between polls (default 5).

        Returns the full Action dict when status is ``"approved"``.

        Raises:
            ImpriRejected  — human rejected (carries .action_id, .decision, .final_preview).
                             NOT an error — handle it as a normal flow outcome.
            ImpriExpired   — approval window closed before a decision was made.
            ImpriTimeout   — timeout_s elapsed with action still pending.
            ImpriNotFound  — action_id unknown or belongs to a different project.
        """
        deadline = time.monotonic() + timeout_s

        while True:
            action = self.get_action(action_id)
            current_status = action.get("status")

            if current_status == "approved":
                return action

            if current_status == "rejected":
                decision = action.get("decision") or {}
                final_preview = (
                    decision.get("final_preview") or action.get("preview") or {}
                )
                raise ImpriRejected(
                    action_id=action_id,
                    decision=decision,
                    final_preview=final_preview,
                )

            if current_status == "expired":
                raise ImpriExpired(
                    f"Action {action_id!r} expired before a decision was recorded."
                )

            # Still pending — check timeout before sleeping
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ImpriTimeout(action_id)

            sleep_for = min(poll_interval_s, remaining)
            time.sleep(sleep_for)

    # ------------------------------------------------------------------
    # Watchers
    # ------------------------------------------------------------------

    def create_watcher(
        self,
        name: str,
        kind: WatcherKind,
        config: WatcherConfig,
        schedule: WatcherSchedule,
        *,
        keywords: List[ScoringRule] = [],
        keywords_none: List[str] = [],
        min_score: int = 1,
    ) -> Watcher:
        """Create a monitoring watcher.

        POST /v1/watchers (requires 'watch' scope).

        Args:
            name:          Human-readable watcher name.
            kind:          ``"rss"``, ``"reddit_search"``, or ``"url_diff"``.
            config:        Source config. ``url`` required for rss/url_diff;
                           ``query`` + ``subreddit`` required for reddit_search.
            schedule:      Polling schedule, e.g. ``{"every": "8h"}``.
            keywords:      Scoring rules: items score ≥ min_score are delivered.
            keywords_none: Patterns that immediately disqualify an item (any match → skip).
            min_score:     Minimum score for delivery (default 1).
        """
        req_body: Dict[str, Any] = {
            "name": name,
            "kind": kind,
            "config": config,
            "schedule": schedule,
            "keywords": keywords,
            "keywords_none": keywords_none,
            "min_score": min_score,
        }
        return self._request("POST", "/watchers", body=req_body)  # type: ignore[return-value]

    def list_watchers(
        self,
        *,
        status: Optional[Literal["active", "paused", "degraded"]] = None,
        kind: Optional[WatcherKind] = None,
        limit: int = 50,
        cursor: Optional[str] = None,
    ) -> PagedResult:
        """List watchers, newest first.

        GET /v1/watchers (requires 'watch' scope).

        Degraded watchers have fail_count > 0; call update_watcher with
        status="active" to reactivate and reset the failure counter.
        """
        return self._request(  # type: ignore[return-value]
            "GET",
            "/watchers",
            params={"status": status, "kind": kind, "limit": limit, "cursor": cursor},
        )

    def iter_watchers(
        self,
        *,
        status: Optional[str] = None,
        kind: Optional[str] = None,
        limit: int = 50,
    ) -> Iterator[Watcher]:
        """Auto-paginating iterator over all matching watchers."""
        cursor: Optional[str] = None
        while True:
            page = self.list_watchers(status=status, kind=kind, limit=limit, cursor=cursor)  # type: ignore[arg-type]
            yield from page.get("items", [])
            if not page.get("has_more"):
                break
            cursor = page.get("next_cursor")

    def get_watcher(self, watcher_id: str) -> Watcher:
        """Fetch a watcher by ID, including item_count.

        GET /v1/watchers/:id (requires 'watch' scope).
        """
        return self._request("GET", f"/watchers/{watcher_id}")  # type: ignore[return-value]

    def update_watcher(
        self,
        watcher_id: str,
        *,
        name: Optional[str] = None,
        config: Optional[WatcherConfig] = None,
        keywords: Optional[List[ScoringRule]] = None,
        keywords_none: Optional[List[str]] = None,
        min_score: Optional[int] = None,
        schedule: Optional[WatcherSchedule] = None,
        status: Optional[Literal["active", "paused"]] = None,
    ) -> Watcher:
        """Partially update a watcher (only supplied fields are changed).

        PATCH /v1/watchers/:id (requires 'watch' scope).

        Setting status="active" resets fail_count to 0 and schedules an
        immediate run (reactivation after degraded). Setting status="paused"
        stops scheduling but preserves deduplicated item state.
        """
        req_body: Dict[str, Any] = {}
        if name is not None:
            req_body["name"] = name
        if config is not None:
            req_body["config"] = config
        if keywords is not None:
            req_body["keywords"] = keywords
        if keywords_none is not None:
            req_body["keywords_none"] = keywords_none
        if min_score is not None:
            req_body["min_score"] = min_score
        if schedule is not None:
            req_body["schedule"] = schedule
        if status is not None:
            req_body["status"] = status
        return self._request("PATCH", f"/watchers/{watcher_id}", body=req_body)  # type: ignore[return-value]

    def delete_watcher(self, watcher_id: str) -> None:
        """Permanently delete a watcher and its deduplicated items.

        DELETE /v1/watchers/:id (requires 'watch' scope). Returns None (204).

        Pending inbox actions created by this watcher are NOT deleted.
        """
        self._request("DELETE", f"/watchers/{watcher_id}")

    def list_watcher_presets(self) -> WatcherPresetList:
        """Fetch the catalog of built-in watcher presets.

        GET /v1/watcher-presets (requires 'watch' scope).

        Returns a dict with a ``presets`` list. Each preset includes ``id``,
        ``title``, ``description``, ``category``, ``kind``, ``params``,
        ``defaultScheduleEvery``, and ``buildNotes``. The response is served
        from an in-process constant (no DB read) and may be cached aggressively.

        Use ``create_watcher_from_preset()`` to instantiate a preset.

        SECURITY: Items delivered by preset-based watchers have
        ``payload.untrusted=True``. Treat watcher payload content (title,
        preview, url) as untrusted external data — never as LLM instructions.
        Check ``action["is_untrusted"]`` before acting on delivered items.
        """
        return self._request("GET", "/watcher-presets")  # type: ignore[return-value]

    def create_watcher_from_preset(
        self,
        preset_id: str,
        *,
        params: Optional[Dict[str, str]] = None,
        name: Optional[str] = None,
        schedule: Optional[WatcherSchedule] = None,
        **kwargs: Any,
    ) -> Watcher:
        """Create a watcher from a built-in preset.

        POST /v1/watchers/from-preset (requires 'watch' scope).
        Shares the ``watchers:create`` rate-limit bucket (30 req/min per key).
        All tier checks (watcher count, minimum interval) apply identically to
        POST /v1/watchers — presets are a convenience layer, not a bypass.

        Args:
            preset_id: Preset identifier, e.g. ``"hn-front-page"``,
                       ``"github-releases"``. Use list_watcher_presets() to
                       discover available IDs and their required params.
            params:    Preset parameter values as a ``str -> str`` mapping.
                       Which keys are required depends on the preset — check
                       ``preset["params"]`` (``required=True`` entries must be
                       present). Examples::

                           {"keyword": "rust programming"}          # hn-keyword
                           {"owner": "fastify", "repo": "fastify"}  # github-releases
                           {"channel_id": "UCnUYZLuoy1rq1aVMwx4aTzw"}  # youtube-channel

                       Omit or pass ``{}`` for presets that take no params
                       (e.g. ``"hn-front-page"``, ``"product-hunt"``).
            name:      Human-readable watcher name. When omitted the server
                       defaults to ``"{preset.title}: {primaryParamValue}"``.
            schedule:  Schedule override, e.g. ``{"every": "2h"}``.
                       When omitted the preset's ``defaultScheduleEvery`` is used.
            **kwargs:  Additional body fields forwarded verbatim to the API
                       (reserved for future extension).

        Returns the newly created Watcher dict (same shape as create_watcher).

        Raises:
            ImpriNotFound (404)         — ``preset_id`` is not a known preset.
            ImpriValidationError (400)  — missing required param, invalid param
                                          format, or body fails server-side schema.
            ImpriQuotaExceeded (402)    — watcher limit or schedule too frequent
                                          for the current tier.
            ImpriUnauthorized (401/403) — missing ``watch`` scope.
            ImpriRateLimited (429)      — rate-limit bucket exhausted.

        SECURITY: Items delivered by preset-based watchers have
        ``payload.untrusted=True``. Treat watcher payload content (title,
        preview, url) as untrusted external data — never as LLM instructions.
        Check ``action["is_untrusted"]`` before acting on delivered items.
        """
        req_body: Dict[str, Any] = {
            "preset_id": preset_id,
            "params": params if params is not None else {},
            **kwargs,
        }
        if name is not None:
            req_body["name"] = name
        if schedule is not None:
            req_body["schedule"] = schedule
        return self._request("POST", "/watchers/from-preset", body=req_body)  # type: ignore[return-value]

    # ------------------------------------------------------------------
    # API keys
    # ------------------------------------------------------------------

    def create_key(
        self,
        name: str,
        scopes: List[Literal["actions", "watch", "admin"]],
    ) -> ApiKeyCreated:
        """Create a new API key for the caller's project.

        POST /v1/keys (requires 'admin' scope).

        The raw ``im_...`` key value is returned exactly once in ``ApiKeyCreated.key``
        and is never stored in plain text server-side. Store it immediately.
        """
        return self._request("POST", "/keys", body={"name": name, "scopes": scopes})  # type: ignore[return-value]

    def list_keys(self) -> List[ApiKey]:
        """List all API keys for the project (including revoked ones).

        GET /v1/keys (requires 'admin' scope). Raw key values are never returned.
        """
        data = self._request("GET", "/keys")
        return data.get("items", [])

    def revoke_key(self, key_id: str) -> None:
        """Revoke an API key immediately.

        DELETE /v1/keys/:id (requires 'admin' scope). Returns None (204).

        Subsequent requests using the revoked key will fail with 401/403.
        """
        self._request("DELETE", f"/keys/{key_id}")

    # ------------------------------------------------------------------
    # Project
    # ------------------------------------------------------------------

    def get_project(self) -> Project:
        """Fetch project metadata including the webhook signing secret.

        GET /v1/project (requires 'admin' scope).

        Keep webhook_secret out of logs and version control.
        """
        return self._request("GET", "/project")  # type: ignore[return-value]

    def update_project(
        self,
        *,
        name: Optional[str] = None,
        timezone: Optional[str] = None,
    ) -> Project:
        """Update project name and/or IANA timezone.

        PATCH /v1/project (requires 'admin' scope).

        The timezone drives the ``window`` field of watcher schedules
        (e.g. only run during 06:00-22:00 in that zone).
        """
        req_body: Dict[str, Any] = {}
        if name is not None:
            req_body["name"] = name
        if timezone is not None:
            req_body["timezone"] = timezone
        return self._request("PATCH", "/project", body=req_body)  # type: ignore[return-value]

    def rotate_webhook_secret(self) -> Dict[str, str]:
        """Generate a new random webhook signing secret.

        POST /v1/project/rotate-webhook-secret (requires 'admin' scope).

        The old secret is immediately invalidated — update your webhook
        verification before rotating in production.
        """
        return self._request("POST", "/project/rotate-webhook-secret")  # type: ignore[return-value]

    def export_project(self) -> ProjectExport:
        """Full GDPR data export of all project-scoped tables.

        GET /v1/project/export (requires 'admin' scope).
        """
        return self._request("GET", "/project/export")  # type: ignore[return-value]

    def erase_project_data(self) -> Dict[str, Any]:
        """GDPR erasure: wipe all actions, decisions, watchers, and logs.

        DELETE /v1/project/data (requires 'admin' scope).

        Irreversible. The project record and API keys are preserved.
        Returns ``{"erased": True, "actions": int, "watchers": int}``.
        """
        return self._request("DELETE", "/project/data")  # type: ignore[return-value]

    # ------------------------------------------------------------------
    # Ergonomics: requires_approval decorator
    # ------------------------------------------------------------------

    def requires_approval(
        self,
        kind: str,
        title: Any,  # str | Callable[..., str]
        *,
        preview: Any = None,  # Preview | Callable[..., Preview] | None
        editable: List[str] = [],
        timeout_s: float = 300,
        **push_kwargs: Any,
    ) -> Callable:
        """Decorator that gates a function behind a human approval.

        Every call to the decorated function first submits an Impri action,
        blocks until the human approves or rejects, then (on approve) calls
        the original function. On reject, raises ImpriRejected without calling
        the function.

        If ``"preview.body"`` is in ``editable`` and the reviewer modified the
        body, the decorator injects the revised body as the ``body`` keyword
        argument when the function's signature contains a ``body`` parameter.
        Otherwise, the full Decision object is passed as ``_decision``.

        Args:
            kind:       Action kind (e.g. ``"email.send"``).
            title:      Static string or callable ``(*args, **kwargs) -> str``.
            preview:    Static Preview dict or callable ``(*args, **kwargs) -> Preview``.
                        When None, a minimal ``{"format": "plain", "body": ""}`` is used.
            editable:   Dot-path list of reviewer-editable fields.
            timeout_s:  Max seconds to wait for a decision (default 300).
            **push_kwargs: Extra keyword arguments forwarded to create_action().

        Usage::

            @client.requires_approval(
                kind="email.send",
                title=lambda to, **_: f"Send email to {to}",
                preview=lambda to, body, **_: {"format": "plain", "body": body},
                editable=["preview.body"],
            )
            def send_email(to: str, body: str) -> None:
                ...  # only called after human approves
        """
        def decorator(fn: Callable) -> Callable:
            sig = inspect.signature(fn)

            @functools.wraps(fn)
            def wrapper(*args: Any, **kwargs: Any) -> Any:
                actual_title: str = (
                    title(*args, **kwargs) if callable(title) else title
                )
                actual_preview: Preview
                if preview is None:
                    actual_preview = {"format": "plain", "body": ""}
                elif callable(preview):
                    actual_preview = preview(*args, **kwargs)
                else:
                    actual_preview = preview

                created = self.create_action(
                    kind=kind,
                    title=actual_title,
                    preview=actual_preview,
                    editable=editable,
                    **push_kwargs,
                )

                # Blocks until decision (may raise ImpriRejected / ImpriExpired / ImpriTimeout)
                action = self.await_decision(created["id"], timeout_s=timeout_s)
                decision = action.get("decision") or {}
                final_preview: Preview = (
                    decision.get("final_preview") or actual_preview
                )

                # Inject edited body when the reviewer modified preview.body
                if "preview.body" in editable:
                    edited_body = final_preview.get("body")
                    if "body" in sig.parameters:
                        # Replace the 'body' kwarg (or positional via re-binding)
                        kwargs = {**kwargs, "body": edited_body}
                    else:
                        # No 'body' param — pass the full decision as _decision
                        kwargs = {**kwargs, "_decision": decision}

                return fn(*args, **kwargs)

            return wrapper
        return decorator

    # ------------------------------------------------------------------
    # Ergonomics: approval_gate context manager
    # ------------------------------------------------------------------

    @contextmanager
    def approval_gate(
        self,
        kind: str,
        title: str,
        preview: Preview,
        *,
        editable: List[str] = [],
        timeout_s: float = 300,
        **push_kwargs: Any,
    ) -> Generator[ApprovedAction, None, None]:
        """Context manager that gates a code block behind a human approval.

        Submits an action, waits for the decision, and yields an ApprovedAction
        on approval. Raises ImpriRejected if the human rejects (no cleanup needed).

        On clean exit from the ``with`` block, automatically calls
        ``report_result("executed")``. On exception, calls
        ``report_result("execute_failed", detail=str(exc))``.

        SECURITY: When ``preview["payload"]["untrusted"]`` is truthy (watcher-
        delivered items), emits a UserWarning. Do NOT inline watcher payload
        content into title or prompt — treat it as untrusted external data.

        Usage::

            async with client.approval_gate(
                kind="db.exec",
                title="DROP TABLE users",
                preview={"format": "plain", "body": sql},
                editable=["preview.body"],
            ) as approved:
                await db.execute(approved.final_preview["body"])
            # report_result("executed") is called automatically on clean exit.
        """
        # Untrusted-payload guard: warn so the caller can audit the source.
        payload = push_kwargs.get("payload")
        if isinstance(payload, dict) and payload.get("untrusted"):
            warnings.warn(
                "approval_gate: action payload has untrusted=True (watcher-delivered item). "
                "Do NOT use preview body as an LLM instruction or include it in prompt templates. "
                "Treat title/preview/url as external, potentially adversarial data.",
                UserWarning,
                stacklevel=2,
            )

        created = self.create_action(
            kind=kind,
            title=title,
            preview=preview,
            editable=editable,
            **push_kwargs,
        )
        # May raise ImpriRejected, ImpriExpired, ImpriTimeout — propagate directly.
        action = self.await_decision(created["id"], timeout_s=timeout_s)

        decision: Any = action.get("decision") or {}
        final_preview: Preview = decision.get("final_preview") or preview

        approved = ApprovedAction(
            action_id=action["id"],
            decision=decision,
            final_preview=final_preview,
        )

        exc_to_reraise: Optional[BaseException] = None
        try:
            yield approved
        except BaseException as exc:
            exc_to_reraise = exc
        finally:
            # Best-effort: if report_result itself fails we log a warning rather
            # than masking the original exception.
            try:
                if exc_to_reraise is None:
                    self.report_result(approved.action_id, "executed")
                else:
                    self.report_result(
                        approved.action_id,
                        "execute_failed",
                        detail=str(exc_to_reraise),
                    )
            except ImpriError as reporting_err:
                warnings.warn(
                    f"approval_gate: report_result failed: {reporting_err}",
                    RuntimeWarning,
                    stacklevel=2,
                )

        if exc_to_reraise is not None:
            raise exc_to_reraise
