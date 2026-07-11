"""impri-crewai — human-in-the-loop approval gate for CrewAI agents.

Quickstart:

    from impri_crewai import ImpriClient, ImpriApprovalTool, ImpriRejected

    client = ImpriClient(api_key="im_...")   # or set IMPRI_API_KEY env var
    tool = ImpriApprovalTool(client=client, action_kind="email.send")

    # Add `tool` to a CrewAI Agent's tools list, then:
    # - The agent calls the tool with a title + body to request human approval.
    # - The call blocks until the human approves or rejects.
    # - On approval, the agent receives the (possibly edited) content.
    # - On rejection, ImpriRejected is raised.
"""
from ._client import ImpriClient, verify_webhook
from ._exceptions import (
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
from .callback import ImpriApprovalCallback
from .tool import ImpriApprovalTool

__all__ = [
    # Client
    "ImpriClient",
    "verify_webhook",
    # CrewAI integration
    "ImpriApprovalTool",
    "ImpriApprovalCallback",
    # Exceptions (all inherit from ImpriError)
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
]
