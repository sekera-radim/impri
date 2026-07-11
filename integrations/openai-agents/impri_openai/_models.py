"""Impri wire-format models and SDK-internal dataclasses."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Optional

# ---------------------------------------------------------------------------
# TypedDict equivalents (plain dicts on the wire; typed here for IDE support)
# ---------------------------------------------------------------------------

# Defined as plain classes using total=False so all keys are optional at
# construction. Callers should not instantiate these directly — they are
# populated from JSON returned by the API.

Preview = dict  # {'format': 'markdown'|'plain'|'diff', 'body': str}
Decision = dict
WebhookDelivery = dict
ActionCreated = dict
Action = dict
PagedResult = dict
DecisionResult = dict
ResultAck = dict

# Literal aliases for documentation clarity
ActionStatus = Literal[
    "pending",
    "approved",
    "rejected",
    "expired",
    "executed",
    "execute_failed",
]

WatcherKind = Literal["rss", "reddit_search", "url_diff"]


# ---------------------------------------------------------------------------
# SDK-internal dataclass yielded by approval_gate
# ---------------------------------------------------------------------------

@dataclass
class ApprovedAction:
    """Yielded by ``approval_gate`` after a human approves an action.

    ``final_preview`` carries the human-edited content when the reviewer
    modified an editable field.  Always use ``final_preview`` for execution
    rather than the originally submitted preview.
    """

    action_id: str
    decision: dict[str, Any]
    final_preview: dict[str, Any]
