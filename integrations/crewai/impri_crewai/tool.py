"""ImpriApprovalTool — CrewAI BaseTool that gates actions behind human approval.

The agent calls this tool when it wants to perform a sensitive action. The call
blocks until a human approves or rejects in the Impri inbox.

CrewAI must be installed for the tool class to be available:
    pip install crewai                        # latest
    pip install "impri-crewai[crewai]"        # via this package's extras

Without crewai the class exists but raises ImportError on instantiation, so
code that imports from this module at the top level still works in test
environments that don't have crewai installed.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any, List, Optional, Type

from ._client import ImpriClient
from ._exceptions import ImpriRejected

try:
    from crewai.tools import BaseTool
    from pydantic import BaseModel, Field, PrivateAttr

    _CREWAI_AVAILABLE = True
except ImportError:
    _CREWAI_AVAILABLE = False


if _CREWAI_AVAILABLE:

    class _ApprovalInput(BaseModel):
        """Input schema for ImpriApprovalTool.

        The agent must fill all three fields when invoking the tool.
        """

        action_title: str = Field(
            description=(
                "Short, human-readable title for the proposed action "
                "(e.g. 'Send email to alice@example.com'). Shown at the top of the "
                "inbox card. Keep it under 120 characters."
            )
        )
        action_body: str = Field(
            description=(
                "Full description of what the agent intends to do. "
                "The human reviewer reads this before deciding. "
                "Use markdown for emails, code, or structured output; "
                "plain text for simple prose."
            )
        )
        preview_format: str = Field(
            default="markdown",
            description="Format of action_body: 'markdown', 'plain', or 'diff'.",
        )

    class ImpriApprovalTool(BaseTool):
        """Gate a proposed agent action behind human approval in the Impri inbox.

        The agent calls this tool before performing any irreversible or high-impact
        action. The tool:
          1. POSTs the action to Impri (POST /v1/actions).
          2. Polls until a human approves or rejects.
          3. On approval: returns the approved content (possibly edited by the human).
          4. On rejection: raises ImpriRejected, which surfaces to the agent as a
             tool error so it can handle the situation gracefully.

        Args:
            client:      An ImpriClient instance configured with your API key.
            action_kind: A dot-namespaced kind string for categorising actions in
                         the inbox (e.g. 'email.send', 'db.exec', 'post.publish').
                         Defaults to 'agent.action'.
            timeout_s:   Seconds to wait for a human decision before raising
                         ImpriTimeout. Default 300 s (5 minutes).
            editable:    Dot-path fields the human may edit before approving
                         (e.g. ['preview.body']). Defaults to ['preview.body']
                         so reviewers can fix the agent's draft.

        Example::

            client = ImpriClient(api_key=os.environ["IMPRI_API_KEY"])
            tool = ImpriApprovalTool(
                client=client,
                action_kind="email.send",
                timeout_s=600,
            )

            agent = Agent(
                role="Marketing assistant",
                goal="Draft and send campaign emails with human sign-off.",
                backstory="...",
                tools=[tool],
            )
        """

        name: str = "impri_approval_gate"
        description: str = (
            "Submit a proposed action to the human-in-the-loop inbox for approval "
            "before executing it. Use this before any irreversible or high-impact "
            "action — sending emails, posting content, modifying data, making "
            "purchases. Provide a clear title and a complete description of what "
            "you intend to do. The tool blocks until the human decides, then "
            "returns the approved (possibly edited) content or raises an error "
            "if the human rejects the action."
        )
        args_schema: Type[BaseModel] = _ApprovalInput  # type: ignore[assignment]

        # Pydantic v2 public fields — set via constructor kwargs.
        action_kind: str = "agent.action"
        timeout_s: float = 300.0
        editable: List[str] = ["preview.body"]

        # Non-Pydantic client stored as a private attribute.
        _client: ImpriClient = PrivateAttr(default=None)  # type: ignore[assignment]

        def __init__(
            self,
            client: ImpriClient,
            *,
            action_kind: str = "agent.action",
            timeout_s: float = 300.0,
            editable: Optional[List[str]] = None,
            **data: Any,
        ) -> None:
            super().__init__(
                action_kind=action_kind,
                timeout_s=timeout_s,
                editable=editable if editable is not None else ["preview.body"],
                **data,
            )
            self._client = client

        def _run(
            self,
            action_title: str,
            action_body: str,
            preview_format: str = "markdown",
        ) -> str:
            """Submit the action for approval and block until the human decides.

            Returns a string the agent can read to confirm approval and retrieve
            the (possibly human-edited) final content.

            Raises ImpriRejected when the human rejects — CrewAI surfaces this
            as a tool error so the agent can handle it appropriately.
            """
            if preview_format not in ("markdown", "plain", "diff"):
                preview_format = "plain"

            preview = {"format": preview_format, "body": action_body}
            created = self._client.create_action(
                kind=self.action_kind,
                title=action_title,
                preview=preview,
                editable=self.editable,
            )
            action_id: str = created["id"]
            inbox_url: str = created.get("inbox_url", "")

            # await_decision raises ImpriRejected / ImpriExpired / ImpriTimeout
            # on non-approval outcomes. Only 'approved' reaches the next line.
            decided = self._client.await_decision(
                action_id, timeout_s=self.timeout_s
            )

            decision = decided.get("decision") or {}
            final_preview = decision.get("final_preview") or preview
            approved_body: str = final_preview.get("body", action_body)

            lines = [
                "APPROVED. Proceed with the following content:",
                "",
                approved_body,
            ]
            if decision.get("diff"):
                lines += [
                    "",
                    f"[Note: the human reviewer edited the content before approving. "
                    f"Use the content above, not your original draft.]",
                ]
            return "\n".join(lines)

else:
    # Provide a stub that gives a clear error without crashing at import time.

    class ImpriApprovalTool:  # type: ignore[no-redef]
        """Stub — crewai is not installed.

        Install it with:
            pip install crewai
            # or, via this package's extras:
            pip install "impri-crewai[crewai]"
        """

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            raise ImportError(
                "crewai is not installed. "
                "Install it with: pip install crewai"
            )
