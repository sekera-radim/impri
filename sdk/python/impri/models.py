"""Impri SDK response models.

All models are TypedDicts (stdlib typing, zero runtime deps). They describe the
JSON shapes returned by the Impri API. Fields marked optional (total=False
subclass) may be absent on some responses.

The dataclass ApprovedAction is the only class that is not a TypedDict — it is
yielded by the approval_gate() context manager and has no JSON counterpart.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Literal, Optional

try:
    from typing import TypedDict
except ImportError:  # Python < 3.8 fallback (unused in practice)
    from typing_extensions import TypedDict  # type: ignore[no-redef]

# ---------------------------------------------------------------------------
# Scalar aliases
# ---------------------------------------------------------------------------

ActionStatus = Literal[
    "pending", "approved", "rejected", "expired", "executed", "execute_failed"
]
WatcherKind = Literal["rss", "reddit_search", "url_diff"]


# ---------------------------------------------------------------------------
# Preview
# ---------------------------------------------------------------------------

class Preview(TypedDict):
    """Content preview shown to the human reviewer."""
    format: Literal["markdown", "plain", "diff"]
    body: str


# ---------------------------------------------------------------------------
# Action models
# ---------------------------------------------------------------------------

class _ActionCreatedRequired(TypedDict):
    id: str
    status: Literal["pending"]
    inbox_url: str
    expires_at: int
    created_at: int


class ActionCreated(_ActionCreatedRequired, total=False):
    """Response from POST /v1/actions (201 new, or 200 deduplicated)."""
    # Present only when an idempotency/content duplicate was found (HTTP 200).
    duplicate_of: str


class Decision(TypedDict, total=False):
    """Human decision recorded for an action.

    Present on GET /v1/actions/:id only after a human has approved or rejected.
    Use final_preview for execution — it carries human-edited content when
    editable fields were modified.
    """
    verdict: Literal["approve", "reject"]
    decided_at: int
    channel: Optional[str]
    # Present when the reviewer changed an editable field before approving.
    final_preview: Optional[Preview]
    # Unified-diff patch against the original preview.body; present when body changed.
    diff: Optional[str]


class WebhookDelivery(TypedDict, total=False):
    """Last webhook delivery attempt for this action."""
    status: str
    attempt: int
    last_status_code: Optional[int]
    last_error: Optional[str]


class _ActionRequired(TypedDict):
    id: str
    kind: str
    title: str
    status: str  # ActionStatus — typed as str so runtime dict checks stay simple
    preview: Preview
    editable: List[str]
    created_at: int
    updated_at: int
    # Computed by the SDK: True when payload.untrusted == True (watcher-delivered items).
    # Treat title/preview/url as untrusted data, not as instructions.
    is_untrusted: bool


class Action(_ActionRequired, total=False):
    """Full action object returned by GET /v1/actions/:id and list responses."""
    payload: Any
    target_url: Optional[str]
    callback_url: Optional[str]
    expires_at: int
    idempotency_key: Optional[str]
    webhook_delivery: Optional[WebhookDelivery]
    decision: Optional[Decision]


class DecisionResult(TypedDict, total=False):
    """Response from POST /v1/actions/:id/decision."""
    id: str
    status: str
    verdict: str
    decided_at: int
    final_preview: Preview
    diff: Optional[str]


class ResultAck(TypedDict):
    """Response from POST /v1/actions/:id/result."""
    id: str
    status: str
    updated_at: int


# ---------------------------------------------------------------------------
# Pagination
# ---------------------------------------------------------------------------

class _PagedResultRequired(TypedDict):
    has_more: bool


class PagedResult(_PagedResultRequired, total=False):
    """Cursor-paginated response for list endpoints."""
    items: List[Any]
    next_cursor: Optional[str]


# ---------------------------------------------------------------------------
# Watcher models
# ---------------------------------------------------------------------------

class ScoringRule(TypedDict):
    pattern: str
    points: int


class WatcherConfig(TypedDict, total=False):
    """Source configuration — required fields depend on kind."""
    url: str          # required for rss and url_diff
    query: str        # required for reddit_search
    subreddit: str    # required for reddit_search


class WatcherSchedule(TypedDict, total=False):
    every: str    # e.g. "8h", "30m", "1d" — min 60 s
    jitter: str   # e.g. "4h" — adds random offset to avoid thundering-herd
    window: str   # "HH:MM-HH:MM" in project timezone, e.g. "06:00-22:00"


class _WatcherRequired(TypedDict):
    id: str
    name: str
    kind: str
    config: WatcherConfig
    keywords: List[ScoringRule]
    keywords_none: List[str]
    min_score: int
    schedule: WatcherSchedule
    status: str
    fail_count: int
    first_run_done: bool
    next_run_at: int
    created_at: int
    updated_at: int


class Watcher(_WatcherRequired, total=False):
    """Watcher resource returned by watcher endpoints."""
    last_error: Optional[str]
    degraded_since: Optional[int]
    last_run_at: Optional[int]
    # Present only on GET /v1/watchers/:id
    item_count: int


# ---------------------------------------------------------------------------
# API key models
# ---------------------------------------------------------------------------

class _ApiKeyRequired(TypedDict):
    id: str
    project_id: str
    prefix: str
    name: str
    scopes: List[str]
    created_at: int
    revoked: bool


class ApiKey(_ApiKeyRequired, total=False):
    """API key metadata (raw key value never returned after creation)."""
    last_used_at: Optional[int]


class ApiKeyCreated(TypedDict):
    """Response from POST /v1/keys. Store .key immediately — returned only once."""
    id: str
    name: str
    key: str       # Full im_... value — not stored in plain text server-side
    prefix: str    # First 16 chars for display/identification
    scopes: List[str]
    project_id: str
    created_at: int
    note: str


# ---------------------------------------------------------------------------
# Project models
# ---------------------------------------------------------------------------

class _ProjectRequired(TypedDict):
    id: str
    name: str
    timezone: str
    created_at: int


class Project(_ProjectRequired, total=False):
    """Project metadata including webhook signing secret (admin scope)."""
    webhook_secret: Optional[str]


class ProjectExport(TypedDict):
    """Full GDPR data export returned by GET /v1/project/export."""
    exported_at: int
    project: Dict[str, Any]
    actions: List[Any]
    decisions: List[Any]
    watchers: List[Any]
    audit_log: List[Any]


# ---------------------------------------------------------------------------
# Ergonomics helpers
# ---------------------------------------------------------------------------

@dataclass
class ApprovedAction:
    """Yielded by the approval_gate() context manager after a human approves.

    Use final_preview for execution — it carries the human-edited content when
    editable fields were modified by the reviewer.
    """
    action_id: str
    decision: Decision
    final_preview: Preview
