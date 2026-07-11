"""Impri LangChain / LangGraph integration.

Provides a human-approval gate for LangChain tools: before a wrapped tool runs,
the proposed call is submitted to the Impri inbox for review. The agent blocks
until a human approves or rejects.

Public surface::

    from integrations.langchain import ImpriClient, ImpriApprovalTool
    from integrations.langchain import (
        ImpriError, ImpriRejected, ImpriTimeout,
        ImpriConfigError, ImpriUnauthorized,
    )

Requires Python 3.10+. The HTTP layer uses stdlib only (``urllib.request``).
``langchain-core`` is optional — ``ImpriClient`` works without it; only
``ImpriApprovalTool`` requires ``langchain-core``.
"""

from ._client import ImpriClient
from ._errors import (
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
)
from .tool import ImpriApprovalTool

__all__ = [
    # Client
    "ImpriClient",
    # Tool wrapper (requires langchain-core)
    "ImpriApprovalTool",
    # Errors
    "ImpriError",
    "ImpriConfigError",
    "ImpriUnauthorized",
    "ImpriNotFound",
    "ImpriConflict",
    "ImpriExpired",
    "ImpriRateLimited",
    "ImpriQuotaExceeded",
    "ImpriValidationError",
    "ImpriApiError",
    "ImpriRejected",
    "ImpriTimeout",
]

__version__ = "0.1.0"
