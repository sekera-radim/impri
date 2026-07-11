"""Impri Python SDK — human-in-the-loop approval API client.

Quickstart::

    import impri
    client = impri.ImpriClient()          # reads IMPRI_API_KEY from env
    action = client.create_action(
        kind="email.send",
        title="Send weekly digest to alice@example.com",
        preview={"format": "plain", "body": "Hi Alice, here's this week's digest..."},
        editable=["preview.body"],
    )
    approved = client.await_decision(action["id"])
    client.report_result(action["id"], "executed")

Cloud endpoint: set IMPRI_BASE_URL=https://api.impri.dev (default: http://localhost:8484).
"""
from .client import ImpriClient, verify_webhook
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
    WatcherPresetParam,
    WatcherSchedule,
)

__all__ = [
    # Client
    "ImpriClient",
    "verify_webhook",
    # Errors
    "ImpriError",
    "ImpriConfigError",
    "ImpriUnauthorized",
    "ImpriNotFound",
    "ImpriConflict",
    "ImpriExpired",
    "ImpriRateLimited",
    "ImpriQuotaExceeded",
    "ImpriRejected",
    "ImpriTimeout",
    "ImpriValidationError",
    "ImpriApiError",
    "ImpriWebhookSignatureError",
    # Models
    "Preview",
    "ActionStatus",
    "ActionCreated",
    "Action",
    "DecisionResult",
    "ResultAck",
    "PagedResult",
    "ApprovedAction",
    "ScoringRule",
    "WatcherConfig",
    "WatcherSchedule",
    "WatcherKind",
    "Watcher",
    "WatcherPresetParam",
    "WatcherPreset",
    "WatcherPresetList",
    "ApiKey",
    "ApiKeyCreated",
    "Project",
    "ProjectExport",
]

__version__ = "0.1.0"
