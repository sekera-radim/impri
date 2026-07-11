"""OpenAI Agents SDK integration for Impri.

This module is **optional** — the core ``impri_openai`` package works without
the ``openai-agents`` package installed.  Import only when you need the
InputGuardrail integration::

    from impri_openai.guardrail import make_guardrail

Requires::

    pip install 'impri-openai[openai-agents]'
"""
from __future__ import annotations

import warnings
from typing import TYPE_CHECKING, Any

from ._errors import ImpriRejected

if TYPE_CHECKING:
    from ._client import ImpriClient

# ---------------------------------------------------------------------------
# Guard: import OpenAI Agents SDK types
# ---------------------------------------------------------------------------

try:
    from agents import (  # type: ignore[import-untyped]
        Agent,
        GuardrailFunctionOutput,
        InputGuardrail,
        RunContextWrapper,
    )
    _AGENTS_AVAILABLE = True
except ImportError:
    _AGENTS_AVAILABLE = False

    # Stubs so the rest of the module parses without the SDK installed
    Agent = Any  # type: ignore[assignment, misc]
    GuardrailFunctionOutput = Any  # type: ignore[assignment, misc]
    InputGuardrail = Any  # type: ignore[assignment, misc]
    RunContextWrapper = Any  # type: ignore[assignment, misc]


def make_guardrail(
    client: "ImpriClient",
    *,
    kind: str = "agent.run",
    title: str = "Agent run requires human approval",
    preview_from_input: bool = True,
    timeout_s: float = 300.0,
    editable: list[str] | None = None,
    **push_kwargs: Any,
) -> Any:
    """Create an OpenAI Agents SDK ``InputGuardrail`` backed by Impri.

    The guardrail submits an Impri approval request for **every agent run**
    and blocks until the human decides:

    - **Approved** → ``tripwire_triggered=False`` (the agent proceeds normally).
    - **Rejected** → ``tripwire_triggered=True`` (the OpenAI Agents runner
      raises ``InputGuardrailTripwireTriggered``).

    The ``output_info`` dict always contains ``action_id`` and ``verdict`` so
    calling code can access the Impri action after the guardrail returns.

    Requires the ``openai-agents`` package::

        pip install 'impri-openai[openai-agents]'

    Usage::

        from agents import Agent, Runner
        from impri_openai import ImpriClient
        from impri_openai.guardrail import make_guardrail

        client = ImpriClient()
        approval = make_guardrail(
            client,
            kind='agent.run',
            title='Approve this agent task',
        )

        agent = Agent(
            name='my-agent',
            instructions='You are a helpful assistant.',
            input_guardrails=[approval],
        )
        # Runner.run() will now pause until a human approves the task
        result = await Runner.run(agent, 'Summarise my emails')

    For tool-level (not run-level) gating, use
    :meth:`ImpriClient.requires_approval` instead.

    Args:
        client: An :class:`ImpriClient` instance.
        kind: Action kind submitted to Impri (default ``'agent.run'``).
        title: Title shown in the Impri inbox card.
        preview_from_input: When True, uses the user's input as the preview
            body so the reviewer sees exactly what the agent was asked to do.
        timeout_s: Seconds to wait for a human decision (default 300).
        editable: Dot-path list of fields the reviewer may edit before
            approving (e.g. ``['preview.body']``).
        **push_kwargs: Forwarded to :meth:`~ImpriClient.create_action`
            (e.g. ``target_url``, ``expires_in``).

    Returns:
        An ``InputGuardrail`` instance ready to pass to ``Agent(input_guardrails=[...])``.

    Raises:
        ImportError: If ``openai-agents`` is not installed.
    """
    if not _AGENTS_AVAILABLE:
        raise ImportError(
            "openai-agents is not installed. "
            "Install it with:  pip install 'impri-openai[openai-agents]'"
        )

    async def _guardrail_fn(
        ctx: RunContextWrapper,
        agent: Agent,
        input: Any,
    ) -> GuardrailFunctionOutput:
        # Build preview body from user input so the reviewer sees what the
        # agent is about to work on.
        if preview_from_input:
            if isinstance(input, str):
                preview_body = input
            elif isinstance(input, list):
                # OpenAI Agents SDK passes a list of TResponseInputItem dicts
                parts: list[str] = []
                for item in input:
                    if isinstance(item, dict):
                        content = item.get("content") or item.get("text") or ""
                        if isinstance(content, str):
                            parts.append(content)
                preview_body = "\n".join(parts) if parts else str(input)
            else:
                preview_body = str(input)
        else:
            preview_body = f"Agent '{agent.name}' was triggered."

        # Truncate to a reasonable length — the preview body max is 256 KB but
        # very long inputs aren't useful for a human approval card.
        preview: dict[str, Any] = {
            "format": "plain",
            "body": preview_body[:8192],
        }

        try:
            created = await client.create_action(
                kind,
                title,
                preview,
                editable=editable or [],
                **push_kwargs,
            )
            action_id = created["id"]

            # Block here until human decides (raises ImpriRejected on reject)
            await client.await_decision(action_id, timeout_s=timeout_s)

            return GuardrailFunctionOutput(
                output_info={"action_id": action_id, "verdict": "approve"},
                tripwire_triggered=False,
            )

        except ImpriRejected as exc:
            # Trip the guardrail — runner raises InputGuardrailTripwireTriggered
            warnings.warn(
                f"Impri guardrail: action {exc.action_id!r} was rejected by the "
                "human reviewer. The agent run has been halted.",
                stacklevel=0,
            )
            return GuardrailFunctionOutput(
                output_info={
                    "action_id": exc.action_id,
                    "verdict": "reject",
                },
                tripwire_triggered=True,
            )

    return InputGuardrail(
        guardrail_function=_guardrail_fn,
        name=f"impri:{kind}",
    )
