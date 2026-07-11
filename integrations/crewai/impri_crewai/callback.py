"""ImpriApprovalCallback — gate CrewAI agent step/task outputs through Impri.

This module provides a callable class that can be wired into a CrewAI Crew or
Agent as `step_callback` or `task_callback`. It intercepts the agent's output,
submits it to the Impri inbox for human review, and raises ImpriRejected if the
human rejects — causing the Crew to surface the rejection as a task failure.

Use when you want automatic approval gates without modifying agent prompts or
tool lists. For explicit, agent-initiated gates, prefer ImpriApprovalTool
(see tool.py) — it lets the agent control when to ask for approval.

  Crew callback hookup:
      from impri_crewai import ImpriClient, ImpriApprovalCallback
      from impri_crewai import ImpriRejected

      client = ImpriClient(api_key=os.environ["IMPRI_API_KEY"])
      gate = ImpriApprovalCallback(
          client,
          action_kind="agent.output",
          title_prefix="Review agent draft",
      )

      crew = Crew(
          agents=[my_agent],
          tasks=[my_task],
          step_callback=gate,   # gate every intermediate step
          # or: task_callback=gate   # gate only final task output
      )
      try:
          result = crew.kickoff()
      except ImpriRejected as exc:
          print(f"Rejected: {exc}")
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from ._client import ImpriClient
from ._exceptions import ImpriRejected

logger = logging.getLogger(__name__)


class ImpriApprovalCallback:
    """Callable that gates a CrewAI step or task output behind Impri approval.

    Args:
        client:       An ImpriClient configured with your API key.
        action_kind:  Kind string for inbox categorisation (e.g. 'agent.output').
        timeout_s:    Seconds to wait for a human decision. Default 300 s.
        title_prefix: Prefix prepended to the auto-generated action title.
        editable:     Dot-path fields the reviewer may edit (default: body only).

    Notes:
        - CrewAI invokes callbacks for their side effects and ignores return values,
          so this callback cannot inject the human-edited content back into the agent
          flow. The primary use is blocking on rejection. If you need the human-edited
          content to feed back into the agent, use ImpriApprovalTool instead.
        - On rejection, ImpriRejected is raised inside the callback. CrewAI will
          propagate this as a task failure, so the caller's `crew.kickoff()` raises.
        - On ImpriTimeout (human did not decide within timeout_s), the exception
          propagates the same way. The action remains pending on the server.
    """

    def __init__(
        self,
        client: ImpriClient,
        *,
        action_kind: str = "agent.output",
        timeout_s: float = 300.0,
        title_prefix: str = "Review agent output",
        editable: Optional[list] = None,
    ) -> None:
        self._client = client
        self.action_kind = action_kind
        self.timeout_s = timeout_s
        self.title_prefix = title_prefix
        self.editable = editable if editable is not None else ["preview.body"]

    def __call__(self, output: Any) -> None:
        """Submit output for human approval. Raises ImpriRejected on rejection.

        Compatible with CrewAI step_callback (receives AgentFinish / AgentAction /
        TaskOutput depending on version) and task_callback (receives TaskOutput).
        """
        content = self._extract_content(output)
        if not content.strip():
            return

        title = self._build_title(content)
        created = self._client.create_action(
            kind=self.action_kind,
            title=title,
            preview={"format": "plain", "body": content},
            editable=self.editable,
        )
        action_id = created["id"]
        inbox_url = created.get("inbox_url", "")
        logger.info(
            "Impri: submitted %r for human approval — open %s to decide.",
            action_id,
            inbox_url,
        )

        # Blocks until approved / rejected / expired / timeout.
        # ImpriRejected, ImpriExpired, ImpriTimeout propagate to the caller.
        self._client.await_decision(action_id, timeout_s=self.timeout_s)
        logger.info("Impri: action %r approved.", action_id)

    def _build_title(self, content: str) -> str:
        snippet = content.strip().replace("\n", " ")
        if len(snippet) > 100:
            snippet = snippet[:97] + "..."
        return f"{self.title_prefix}: {snippet}"

    @staticmethod
    def _extract_content(output: Any) -> str:
        """Extract a plain-text string from various CrewAI output types."""
        if isinstance(output, str):
            return output
        # TaskOutput (crewai >= 0.36): .raw holds the string output
        if hasattr(output, "raw"):
            return str(output.raw)
        # AgentFinish (langchain-style): .return_values["output"]
        if hasattr(output, "return_values"):
            rv = output.return_values
            if isinstance(rv, dict):
                return str(rv.get("output", rv))
            return str(rv)
        # AgentAction (intermediate step): .log is the agent's reasoning
        if hasattr(output, "log"):
            return str(output.log)
        return str(output)
