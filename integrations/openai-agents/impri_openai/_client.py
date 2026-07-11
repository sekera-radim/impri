"""Impri async REST client with ergonomic approval helpers."""
from __future__ import annotations

import asyncio
import hashlib
import inspect
import os
import time
import warnings
from contextlib import asynccontextmanager
from functools import wraps
from typing import Any, AsyncGenerator, Callable, Literal, TypeVar

import httpx

from ._errors import (
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
)
from ._models import ApprovedAction

F = TypeVar("F", bound=Callable[..., Any])

_DEFAULT_BASE_URL = "http://localhost:8484"
_DEFAULT_POLL_INTERVAL_S: float = 5.0
_DEFAULT_TIMEOUT_S: float = 300.0


class ImpriClient:
    """Async Impri REST client.

    Key and base URL resolution order:

    - ``api_key``: constructor argument → ``IMPRI_API_KEY`` env var
    - ``base_url``: constructor argument → ``IMPRI_BASE_URL`` env var →
      ``http://localhost:8484`` (self-hosted default)

    Use as an async context manager to ensure the HTTP connection pool is
    properly closed::

        async with ImpriClient(api_key='im_...') as client:
            action = await client.create_action(...)

    Alternatively call ``await client.close()`` explicitly.
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        resolved_key = api_key or os.environ.get("IMPRI_API_KEY", "")
        if not resolved_key:
            raise ImpriConfigError(
                "api_key is required. Pass it as a constructor argument or "
                "set the IMPRI_API_KEY environment variable."
            )

        resolved_base = (
            base_url
            or os.environ.get("IMPRI_BASE_URL", "")
            or _DEFAULT_BASE_URL
        ).rstrip("/")

        self._api_key = resolved_key
        self._base_url = resolved_base
        self._http = http_client or httpx.AsyncClient(timeout=30.0)

    # ------------------------------------------------------------------
    # Internal HTTP helpers
    # ------------------------------------------------------------------

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    def _url(self, path: str) -> str:
        return f"{self._base_url}/v1{path}"

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: dict[str, Any] | None = None,
    ) -> Any:
        """Make a request and return the parsed JSON body, or None for 204."""
        response = await self._http.request(
            method,
            self._url(path),
            headers=self._headers(),
            json=json,
            params=(
                {k: v for k, v in (params or {}).items() if v is not None}
                or None
            ),
        )
        return await self._parse_response(response)

    async def _parse_response(self, response: httpx.Response) -> Any:
        if response.status_code == 204:
            return None

        if response.is_success:
            return response.json()

        # Extract error detail from response body
        detail = ""
        body: dict[str, Any] = {}
        try:
            body = response.json()
            detail = body.get("message") or body.get("error") or ""
        except Exception:
            detail = response.text

        status = response.status_code

        if status in (401, 403):
            raise ImpriUnauthorized(
                f"Authentication failed: {detail or 'verify IMPRI_API_KEY and its scopes.'}",
                response=response,
            )
        if status == 402:
            raise ImpriQuotaExceeded(
                f"Quota exceeded: {detail}",
                limit=body.get("limit"),
                tier=body.get("tier"),
                response=response,
            )
        if status == 404:
            raise ImpriNotFound(
                f"Not found: {detail or 'verify the ID belongs to this project.'}",
                response=response,
            )
        if status == 409:
            raise ImpriConflict(
                f"Conflict: {detail}",
                response=response,
            )
        if status == 410:
            raise ImpriExpired(
                f"Expired: {detail or 'the approval window has closed.'}",
                response=response,
            )
        if status in (400, 422):
            raise ImpriValidationError(
                f"Validation error: {detail}",
                issues=body.get("issues"),
                response=response,
            )
        if status == 429:
            raw_after = response.headers.get("Retry-After", "")
            retry_after = int(raw_after) if raw_after.isdigit() else None
            raise ImpriRateLimited(
                f"Rate limited: {detail or 'wait a moment and retry.'}",
                retry_after=retry_after,
                response=response,
            )
        raise ImpriApiError(
            f"API error {status}: {detail or response.text}",
            status_code=status,
            response=response,
        )

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------

    async def create_action(
        self,
        kind: str,
        title: str,
        preview: dict[str, Any],
        *,
        payload: Any = None,
        target_url: str | None = None,
        callback_url: str | None = None,
        expires_in: int = 259200,
        idempotency_key: str | None = None,
        editable: list[str] | None = None,
    ) -> dict[str, Any]:
        """POST /v1/actions — submit an action for human approval.

        Returns an ActionCreated dict with ``id``, ``status``, ``inbox_url``,
        ``expires_at``, and ``created_at``. HTTP 200 (not 201) is returned when
        an ``idempotency_key`` match or soft-duplicate is found — check
        ``.get('duplicate_of')`` to distinguish.

        Args:
            kind: Free-form taxonomy string (e.g. ``'email.send'``).
            title: Human-readable title shown in the inbox card.
            preview: ``{'format': 'markdown'|'plain'|'diff', 'body': str}``
                (body max 256 KB).
            payload: Opaque data returned with webhooks and in GET responses.
            target_url: Link shown in the inbox (e.g. Reddit thread URL).
            callback_url: Webhook endpoint; omit to use polling.
            expires_in: Seconds until the action expires (300–2592000; default 72 h).
            idempotency_key: Stable key for deduplication across retries.
            editable: Dot-path fields the reviewer may modify (e.g.
                ``['preview.body']``).
        """
        body: dict[str, Any] = {
            "kind": kind,
            "title": title,
            "preview": preview,
        }
        if payload is not None:
            body["payload"] = payload
        if target_url is not None:
            body["target_url"] = target_url
        if callback_url is not None:
            body["callback_url"] = callback_url
        if expires_in != 259200:
            body["expires_in"] = expires_in
        if idempotency_key is not None:
            body["idempotency_key"] = idempotency_key
        if editable:
            body["editable"] = editable

        return await self._request("POST", "/actions", json=body)

    async def get_action(self, action_id: str) -> dict[str, Any]:
        """GET /v1/actions/:id — fetch a single action with its current status.

        The ``decision`` key is present only after a human has decided.
        Use ``decision['final_preview']`` for execution when editable fields
        may have been modified by the reviewer.

        The SDK adds an ``is_untrusted: bool`` convenience key — True when
        the action was delivered by a Watcher (``payload.untrusted == True``).
        Treat the content of untrusted actions as external data, never as
        instructions to the agent.
        """
        data: dict[str, Any] = await self._request("GET", f"/actions/{action_id}")
        payload = data.get("payload") or {}
        data["is_untrusted"] = (
            isinstance(payload, dict) and payload.get("untrusted") is True
        )
        return data

    async def list_actions(
        self,
        *,
        status: str | None = None,
        kind: str | None = None,
        since: int | None = None,
        limit: int = 50,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        """GET /v1/actions — cursor-paginated list of actions (newest first).

        Use ``next_cursor`` with ``cursor=`` to page when ``has_more`` is True.
        Rate-limited to 300 GET/min per key.
        """
        return await self._request(
            "GET",
            "/actions",
            params={
                "status": status,
                "kind": kind,
                "since": since,
                "limit": limit,
                "cursor": cursor,
            },
        )

    async def decide(
        self,
        action_id: str,
        verdict: Literal["approve", "reject"],
        *,
        edited: dict[str, Any] | None = None,
        channel: str | None = None,
    ) -> dict[str, Any]:
        """POST /v1/actions/:id/decision — programmatically approve or reject.

        Primarily used by the web inbox; SDKs expose it for scripted approvals.
        The action must be in ``'pending'`` state (409 otherwise).
        ``edited`` is a dict of dot-path overrides restricted to the action's
        editable whitelist.
        """
        body: dict[str, Any] = {"verdict": verdict}
        if edited is not None:
            body["edited"] = edited
        if channel is not None:
            body["channel"] = channel
        return await self._request("POST", f"/actions/{action_id}/decision", json=body)

    async def report_result(
        self,
        action_id: str,
        status: Literal["executed", "execute_failed"],
        *,
        detail: str | None = None,
    ) -> dict[str, Any]:
        """POST /v1/actions/:id/result — report execution outcome after approval.

        Only callable when the action is in ``'approved'`` state (409 otherwise).
        ``detail`` is a free-form string for the audit log (error message, HTTP status, etc.).
        """
        body: dict[str, Any] = {"status": status}
        if detail is not None:
            body["detail"] = detail
        return await self._request("POST", f"/actions/{action_id}/result", json=body)

    async def await_decision(
        self,
        action_id: str,
        *,
        timeout_s: float = _DEFAULT_TIMEOUT_S,
        poll_interval_s: float = _DEFAULT_POLL_INTERVAL_S,
    ) -> dict[str, Any]:
        """Poll GET /v1/actions/:id until the action leaves ``'pending'``.

        Returns the full Action dict on ``'approved'``.  Use
        ``action['decision']['final_preview']`` for execution — it carries the
        human-edited content when the reviewer used edit-before-approve.

        Raises:
            ImpriRejected: Human rejected. Catch as normal flow (not an error).
            ImpriExpired: Approval window closed before a decision.
            ImpriTimeout: ``timeout_s`` elapsed; action is still pending
                server-side.  You can call this method again to resume waiting.
        """
        if poll_interval_s < 5.0:
            warnings.warn(
                f"poll_interval_s={poll_interval_s} is below the recommended "
                "floor of 5 s. Very short intervals may hit the 300 req/min "
                "rate limit for GET /v1/actions/:id.",
                stacklevel=2,
            )

        deadline = time.monotonic() + timeout_s

        while True:
            action = await self.get_action(action_id)
            state = action.get("status")

            if state == "approved":
                return action

            if state == "rejected":
                decision: dict[str, Any] = action.get("decision") or {}
                final_preview = (
                    decision.get("final_preview") or action.get("preview") or {}
                )
                raise ImpriRejected(
                    action_id=action_id,
                    decision=decision,
                    final_preview=final_preview,
                )

            if state == "expired":
                raise ImpriExpired(
                    f"Action {action_id!r} expired before a human decision was made."
                )

            # Still pending — check deadline before sleeping
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ImpriTimeout(action_id)

            await asyncio.sleep(min(poll_interval_s, remaining))

    # ------------------------------------------------------------------
    # Ergonomic helper: requires_approval decorator
    # ------------------------------------------------------------------

    def requires_approval(
        self,
        kind: str,
        title: str | Callable[..., str],
        *,
        preview: dict[str, Any] | Callable[..., dict[str, Any]] | None = None,
        editable: list[str] | None = None,
        timeout_s: float = _DEFAULT_TIMEOUT_S,
        **push_kwargs: Any,
    ) -> Callable[[F], F]:
        """Decorator that gates every call to the wrapped async function through Impri.

        Every invocation of the decorated function submits an Impri action,
        blocks until the human decides, then:

        - **Approved** — calls the original function (injecting the
          human-edited ``body`` argument when ``'preview.body'`` is editable
          and was changed by the reviewer).
        - **Rejected** — raises :exc:`ImpriRejected` without calling the function.

        Compatible with the OpenAI Agents SDK's ``@function_tool`` decorator::

            from agents import function_tool
            from impri_openai import ImpriClient

            client = ImpriClient()

            @function_tool
            @client.requires_approval(
                kind='email.send',
                title=lambda to, **_: f'Send email to {to}',
                preview=lambda to, body, **_: {'format': 'plain', 'body': body},
                editable=['preview.body'],
            )
            async def send_email(to: str, body: str) -> str:
                ...  # only runs after human approval

        Args:
            kind: Action kind string (e.g. ``'email.send'``).
            title: Static title string or callable that receives the same args
                as the wrapped function and returns a title string.
            preview: Static preview dict, callable that returns a preview dict,
                or None (auto-generates ``fn_name(args…)`` in plain format).
            editable: Dot-path fields the reviewer may edit.
            timeout_s: How long to wait for a human decision.
            **push_kwargs: Forwarded to :meth:`create_action` (e.g.
                ``target_url``, ``expires_in``, ``callback_url``).
        """
        def decorator(fn: F) -> F:
            sig = inspect.signature(fn)
            params = sig.parameters

            @wraps(fn)
            async def wrapper(*args: Any, **kwargs: Any) -> Any:
                # Resolve title
                resolved_title = (
                    title(*args, **kwargs) if callable(title) else title
                )

                # Resolve preview
                if callable(preview):
                    resolved_preview: dict[str, Any] = preview(*args, **kwargs)
                elif preview is not None:
                    resolved_preview = preview
                else:
                    # Auto-preview: show function call signature
                    bound = sig.bind(*args, **kwargs)
                    bound.apply_defaults()
                    arg_repr = ", ".join(
                        f"{k}={v!r}" for k, v in bound.arguments.items()
                    )
                    resolved_preview = {
                        "format": "plain",
                        "body": f"{fn.__name__}({arg_repr})",
                    }

                # Auto-generate stable idempotency key when caller didn't supply one
                ik = push_kwargs.get("idempotency_key") or _auto_idempotency_key(
                    kind, resolved_title, resolved_preview.get("body", "")
                )

                # Submit and wait
                created = await self.create_action(
                    kind,
                    resolved_title,
                    resolved_preview,
                    editable=editable or [],
                    idempotency_key=ik,
                    **{k: v for k, v in push_kwargs.items() if k != "idempotency_key"},
                )
                action = await self.await_decision(
                    created["id"],
                    timeout_s=timeout_s,
                )

                # Inject human-edited content if reviewer changed an editable field
                decision: dict[str, Any] = action.get("decision") or {}
                final_preview = decision.get("final_preview")

                if editable and "preview.body" in editable and final_preview:
                    # Bind all args to named parameters
                    bound = sig.bind(*args, **kwargs)
                    bound.apply_defaults()
                    all_args = dict(bound.arguments)

                    if "body" in params:
                        # Inject the edited body directly
                        all_args["body"] = final_preview["body"]
                        return await fn(**all_args)

                    # Function doesn't have 'body' param — pass decision as kwarg
                    # only if the function accepts **kwargs or has '_decision' param
                    has_var_kw = any(
                        p.kind == inspect.Parameter.VAR_KEYWORD
                        for p in params.values()
                    )
                    if "_decision" in params or has_var_kw:
                        all_args["_decision"] = decision
                    return await fn(**all_args)

                return await fn(*args, **kwargs)

            return wrapper  # type: ignore[return-value]

        return decorator

    # ------------------------------------------------------------------
    # Ergonomic helper: approval_gate context manager
    # ------------------------------------------------------------------

    @asynccontextmanager
    async def approval_gate(
        self,
        kind: str,
        title: str,
        preview: dict[str, Any],
        *,
        editable: list[str] | None = None,
        timeout_s: float = _DEFAULT_TIMEOUT_S,
        **push_kwargs: Any,
    ) -> AsyncGenerator[ApprovedAction, None]:
        """Async context manager that gates the body block on Impri approval.

        Submits an action and blocks until a human decides.  On approval,
        yields an :class:`ApprovedAction`.  ``__aexit__`` automatically calls
        :meth:`report_result` — ``'executed'`` on clean exit, ``'execute_failed'``
        when an exception propagates out of the ``async with`` block.

        Raises :exc:`ImpriRejected` before yielding if the human rejected
        (no ``report_result`` is called in that case)::

            async with client.approval_gate(
                kind='db.exec',
                title='DROP TABLE users',
                preview={'format': 'plain', 'body': sql},
                editable=['preview.body'],
            ) as approved:
                await db.execute(approved.final_preview['body'])
            # report_result('executed') is called automatically here
        """
        ik = push_kwargs.pop("idempotency_key", None) or _auto_idempotency_key(
            kind, title, preview.get("body", "")
        )
        created = await self.create_action(
            kind,
            title,
            preview,
            editable=editable or [],
            idempotency_key=ik,
            **push_kwargs,
        )
        action_id = created["id"]

        # Raises ImpriRejected / ImpriExpired / ImpriTimeout before yielding
        action = await self.await_decision(action_id, timeout_s=timeout_s)

        decision: dict[str, Any] = action.get("decision") or {}
        final_preview: dict[str, Any] = (
            decision.get("final_preview") or preview
        )
        approved = ApprovedAction(
            action_id=action_id,
            decision=decision,
            final_preview=final_preview,
        )

        exc_caught: BaseException | None = None
        try:
            yield approved
        except BaseException as exc:
            exc_caught = exc
            raise
        finally:
            result_status: Literal["executed", "execute_failed"] = (
                "execute_failed" if exc_caught is not None else "executed"
            )
            detail = str(exc_caught) if exc_caught is not None else None
            try:
                await self.report_result(action_id, result_status, detail=detail)
            except Exception:
                # Never let report_result failure obscure the original exception
                pass

    # ------------------------------------------------------------------
    # Watchers
    # ------------------------------------------------------------------

    async def create_watcher(
        self,
        name: str,
        kind: Literal["rss", "reddit_search", "url_diff"],
        config: dict[str, Any],
        schedule: dict[str, Any],
        *,
        keywords: list[dict[str, Any]] | None = None,
        keywords_none: list[str] | None = None,
        min_score: int = 1,
    ) -> dict[str, Any]:
        """POST /v1/watchers — create a monitoring watcher."""
        body: dict[str, Any] = {
            "name": name,
            "kind": kind,
            "config": config,
            "schedule": schedule,
        }
        if keywords:
            body["keywords"] = keywords
        if keywords_none:
            body["keywords_none"] = keywords_none
        if min_score != 1:
            body["min_score"] = min_score
        return await self._request("POST", "/watchers", json=body)

    async def list_watchers(
        self,
        *,
        status: str | None = None,
        kind: str | None = None,
        limit: int = 50,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        """GET /v1/watchers — cursor-paginated list of watchers."""
        return await self._request(
            "GET",
            "/watchers",
            params={"status": status, "kind": kind, "limit": limit, "cursor": cursor},
        )

    async def get_watcher(self, watcher_id: str) -> dict[str, Any]:
        """GET /v1/watchers/:id — fetch a watcher (includes item_count)."""
        return await self._request("GET", f"/watchers/{watcher_id}")

    async def update_watcher(self, watcher_id: str, **fields: Any) -> dict[str, Any]:
        """PATCH /v1/watchers/:id — partial update (only supplied fields change)."""
        return await self._request("PATCH", f"/watchers/{watcher_id}", json=fields)

    async def delete_watcher(self, watcher_id: str) -> None:
        """DELETE /v1/watchers/:id — permanently deletes the watcher and its items."""
        await self._request("DELETE", f"/watchers/{watcher_id}")

    # ------------------------------------------------------------------
    # API Keys
    # ------------------------------------------------------------------

    async def create_key(self, name: str, scopes: list[str]) -> dict[str, Any]:
        """POST /v1/keys — create a new API key (admin scope required).

        The raw ``im_...`` key value is returned exactly once — store it immediately.
        """
        return await self._request("POST", "/keys", json={"name": name, "scopes": scopes})

    async def list_keys(self) -> list[dict[str, Any]]:
        """GET /v1/keys — list all keys for the project (admin scope required)."""
        return await self._request("GET", "/keys")

    async def revoke_key(self, key_id: str) -> None:
        """DELETE /v1/keys/:id — revoke a key (admin scope required)."""
        await self._request("DELETE", f"/keys/{key_id}")

    # ------------------------------------------------------------------
    # Project
    # ------------------------------------------------------------------

    async def get_project(self) -> dict[str, Any]:
        """GET /v1/project — project metadata including webhook_secret."""
        return await self._request("GET", "/project")

    async def update_project(
        self,
        *,
        name: str | None = None,
        timezone: str | None = None,
    ) -> dict[str, Any]:
        """PATCH /v1/project — update name and/or IANA timezone."""
        body: dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if timezone is not None:
            body["timezone"] = timezone
        return await self._request("PATCH", "/project", json=body)

    async def rotate_webhook_secret(self) -> dict[str, Any]:
        """POST /v1/project/rotate-webhook-secret — generate a new signing secret."""
        return await self._request("POST", "/project/rotate-webhook-secret")

    async def export_project(self) -> dict[str, Any]:
        """GET /v1/project/export — full GDPR data export."""
        return await self._request("GET", "/project/export")

    async def erase_project_data(self) -> dict[str, Any]:
        """DELETE /v1/project/data — GDPR erasure (irreversible)."""
        return await self._request("DELETE", "/project/data")

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def close(self) -> None:
        """Close the underlying HTTP connection pool."""
        await self._http.aclose()

    async def __aenter__(self) -> "ImpriClient":
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.close()


# ---------------------------------------------------------------------------
# Auto idempotency key
# ---------------------------------------------------------------------------

def _auto_idempotency_key(kind: str, title: str, body: str) -> str:
    """Generate a stable idempotency key for automatic deduplication.

    Keyed by (kind, title, preview.body) and a UTC wall-clock day bucket so
    that repeated calls within the same logical day de-duplicate automatically.
    Callers can always override by passing ``idempotency_key=`` explicitly.
    """
    day = time.strftime("%Y-%m-%d", time.gmtime())
    content = f"{kind}\x00{title}\x00{body}\x00{day}"
    return "sdk-" + hashlib.sha256(content.encode()).hexdigest()[:32]
