"""impri-openai — Impri human-approval integration for the OpenAI Agents SDK.

Quick start::

    import asyncio
    from agents import function_tool
    from impri_openai import ImpriClient

    client = ImpriClient()  # reads IMPRI_API_KEY from env

    @function_tool
    @client.requires_approval(
        kind='email.send',
        title=lambda to, **_: f'Send email to {to}',
        preview=lambda to, body, **_: {'format': 'plain', 'body': body},
        editable=['preview.body'],
    )
    async def send_email(to: str, body: str) -> str:
        # Only executes after a human approves in the Impri inbox
        return 'sent'

For run-level (all-or-nothing) gating, use the InputGuardrail helper::

    from impri_openai.guardrail import make_guardrail
    from agents import Agent

    guardrail = make_guardrail(client, kind='agent.run', title='Approve agent task')
    agent = Agent(name='my-agent', input_guardrails=[guardrail], ...)
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
    ImpriWebhookSignatureError,
)
from ._models import ApprovedAction
from ._webhook import verify_webhook

__all__ = [
    # Client
    "ImpriClient",
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
    "ImpriWebhookSignatureError",
    # Models
    "ApprovedAction",
    # Webhook helper
    "verify_webhook",
]

__version__ = "0.1.0"
