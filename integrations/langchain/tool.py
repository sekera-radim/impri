"""LangChain / LangGraph tool wrapper with Impri human-approval gate.

The LangChain import is guarded — this module loads fine without
``langchain-core`` installed. Instantiating ``ImpriApprovalTool`` without
it raises ``ImportError`` with a clear install message.

Requires:
    pip install langchain-core>=0.1

Usage in LangGraph::

    from langchain_community.tools.shell import ShellTool
    from integrations.langchain import ImpriClient, ImpriApprovalTool

    client = ImpriClient(api_key="im_...")
    safe_shell = ImpriApprovalTool.wrap(
        ShellTool(),
        client=client,
        kind="shell.exec",
        editable=["preview.body"],
    )

    # Register with a LangGraph ToolNode — the graph blocks at this node
    # until a human approves in the Impri inbox.
    from langgraph.prebuilt import ToolNode
    tool_node = ToolNode([safe_shell])
"""
from __future__ import annotations

import json
from typing import Any, Optional

from ._client import ImpriClient
from ._errors import ImpriRejected, ImpriTimeout

# Guard the import so the module can be imported in test / non-LangChain
# environments without crashing. Instantiation raises ImportError if absent.
try:
    from langchain_core.callbacks import CallbackManagerForToolRun
    from langchain_core.tools import BaseTool
    _LANGCHAIN_AVAILABLE = True
except ImportError:
    _LANGCHAIN_AVAILABLE = False
    BaseTool = object  # type: ignore[assignment, misc]
    CallbackManagerForToolRun = None  # type: ignore[assignment]


if _LANGCHAIN_AVAILABLE:
    class ImpriApprovalTool(BaseTool):  # type: ignore[misc]
        """LangChain tool that gates any other tool behind Impri human approval.

        Before the wrapped tool's logic runs, the proposed call is submitted to
        the Impri inbox as a pending action. Execution blocks (synchronous poll)
        until a reviewer approves or rejects in their inbox. On approval the
        wrapped tool runs and the result is reported back to Impri. On rejection
        ``ImpriRejected`` propagates to the agent.

        Works transparently as a drop-in inside ``langgraph.prebuilt.ToolNode``
        because LangGraph calls ``tool.run(args)`` exactly as LangChain does.

        Use :meth:`wrap` as the preferred constructor — it copies the wrapped
        tool's ``name``, ``description``, and ``args_schema`` so the LLM sees
        identical tool metadata.

        Attributes:
            impri_client:        Configured :class:`ImpriClient` instance.
            wrapped_tool:        The tool whose execution is gated.
            impri_kind:          Action kind label (e.g. ``'shell.exec'``).
            impri_preview_format: ``'plain'`` | ``'markdown'`` | ``'diff'``.
            impri_editable:      Dot-path fields the reviewer may edit.
            impri_timeout_s:     Seconds to poll before raising ``ImpriTimeout``.
            impri_poll_interval_s: Seconds between GET /v1/actions/:id polls.
            impri_report_result: If ``True`` (default), calls ``report_result``
                                 after execution to close the audit loop.
        """

        # Allow arbitrary Pydantic types (ImpriClient, BaseTool subclass).
        # langchain-core's BaseTool already sets this; repeat for safety.
        model_config = {"arbitrary_types_allowed": True}

        # Required BaseTool fields — set by wrap() to match the wrapped tool.
        name: str = "impri_approval"
        description: str = "Submits a proposed tool call for human approval via Impri."

        # Impri-specific fields (prefixed to avoid clashing with BaseTool attrs).
        impri_client: Any  # ImpriClient — typed as Any for Pydantic compatibility
        wrapped_tool: Any  # BaseTool subclass
        impri_kind: str = "tool.call"
        impri_preview_format: str = "plain"
        impri_editable: list = ["preview.body"]  # type: ignore[assignment]
        impri_timeout_s: float = 300.0
        impri_poll_interval_s: float = 5.0
        impri_report_result: bool = True

        @classmethod
        def wrap(
            cls,
            tool: Any,
            *,
            client: ImpriClient,
            kind: str | None = None,
            preview_format: str = "plain",
            editable: list[str] | None = None,
            timeout_s: float = 300.0,
            poll_interval_s: float = 5.0,
            report_result: bool = True,
        ) -> "ImpriApprovalTool":
            """Wrap ``tool`` with an Impri approval gate.

            The resulting tool shares the wrapped tool's ``name``, ``description``,
            and ``args_schema`` so the LLM calls it with exactly the same arguments.

            Args:
                tool:           Any ``BaseTool`` instance.
                client:         Configured :class:`ImpriClient`.
                kind:           Action kind label; defaults to ``tool.<tool.name>``.
                preview_format: Format for the inbox preview card.
                editable:       Fields the reviewer may edit (default ``['preview.body']``).
                timeout_s:      Poll timeout in seconds.
                poll_interval_s: Poll interval in seconds (minimum 5 recommended).
                report_result:  Whether to call ``report_result`` after execution.
            """
            kwargs: dict[str, Any] = dict(
                name=tool.name,
                description=f"[Impri approval required] {tool.description}",
                impri_client=client,
                wrapped_tool=tool,
                impri_kind=kind or f"tool.{tool.name}",
                impri_preview_format=preview_format,
                impri_editable=editable if editable is not None else ["preview.body"],
                impri_timeout_s=timeout_s,
                impri_poll_interval_s=poll_interval_s,
                impri_report_result=report_result,
            )
            # Inherit the wrapped tool's args_schema when available so that
            # LangGraph ToolNode passes structured kwargs to _run correctly.
            schema = getattr(tool, "args_schema", None)
            if schema is not None:
                kwargs["args_schema"] = schema
            return cls(**kwargs)

        # ── Helpers ──────────────────────────────────────────────────────────

        def _format_preview(self, tool_input: Any) -> dict[str, str]:
            """Serialize tool_input to an Impri preview dict."""
            if isinstance(tool_input, dict):
                body = json.dumps(tool_input, indent=2, ensure_ascii=False)
            else:
                body = str(tool_input)
            return {"format": self.impri_preview_format, "body": body}

        def _make_title(self, tool_input: Any) -> str:
            """Build a concise inbox card title from the tool input."""
            if isinstance(tool_input, str) and len(tool_input) <= 80:
                return f"[{self.name}] {tool_input}"
            if isinstance(tool_input, dict):
                first = next(iter(tool_input.values()), None)
                if isinstance(first, str) and len(first) <= 80:
                    return f"[{self.name}] {first}"
            return f"[{self.name}] — awaiting human approval"

        def _effective_input(self, original: Any, decision: dict[str, Any]) -> Any:
            """Return the human-edited input when the reviewer changed preview.body.

            If ``decision.diff`` is absent, the original input is returned
            unchanged. If the reviewer edited the body and the original was a
            dict, we try to parse it back as JSON; on failure we return the raw
            string so the wrapped tool can decide what to do.
            """
            if not decision.get("diff"):
                return original
            final_preview = decision.get("final_preview")
            if not final_preview:
                return original
            edited_body: str = final_preview.get("body", "")
            if isinstance(original, dict):
                try:
                    return json.loads(edited_body)
                except json.JSONDecodeError:
                    return edited_body
            return edited_body

        # ── BaseTool interface ────────────────────────────────────────────────

        def _run(
            self,
            *args: Any,
            run_manager: Optional[CallbackManagerForToolRun] = None,
            **kwargs: Any,
        ) -> str:
            """Gate the wrapped tool behind an Impri approval, then run it.

            Normalises positional and keyword arguments from both plain-string
            and structured (args_schema) tool calls before pushing to the inbox.

            Raises:
                ImpriRejected: propagated from ``await_decision`` when rejected.
                ImpriTimeout:  propagated from ``await_decision`` on timeout.
            """
            # Normalise tool_input from whatever LangChain / LangGraph passes.
            # LangGraph ToolNode passes structured kwargs when args_schema is set;
            # plain string tools pass a single positional arg.
            if args and not kwargs:
                tool_input: Any = args[0] if len(args) == 1 else list(args)
            elif kwargs and not args:
                # Drop run_manager from kwargs — it's LangChain internal plumbing.
                tool_input = {k: v for k, v in kwargs.items() if k != "run_manager"}
            elif args and kwargs:
                clean_kw = {k: v for k, v in kwargs.items() if k != "run_manager"}
                tool_input = {"_args": list(args), **clean_kw}
            else:
                tool_input = ""

            # 1. Submit proposed action to the Impri inbox.
            action = self.impri_client.create_action(
                kind=self.impri_kind,
                title=self._make_title(tool_input),
                preview=self._format_preview(tool_input),
                editable=self.impri_editable,
            )
            action_id: str = action["id"]

            # 2. Block (polling) until a human decides.
            approved = self.impri_client.await_decision(
                action_id,
                timeout_s=self.impri_timeout_s,
                poll_interval_s=self.impri_poll_interval_s,
            )
            # ImpriRejected / ImpriTimeout propagate automatically.

            # 3. Resolve the effective input — reviewer may have edited preview.body.
            decision = approved.get("decision") or {}
            effective = self._effective_input(tool_input, decision)

            # 4. Execute the wrapped tool and close the audit loop.
            if self.impri_report_result:
                try:
                    result: str = self.wrapped_tool.run(effective)
                    self.impri_client.report_result(action_id, "executed")
                    return result
                except ImpriRejected:
                    raise  # decision reversal guard — should not happen here
                except Exception as exc:
                    # Best-effort: if report_result itself fails the original
                    # exception is more important and re-raised below.
                    try:
                        self.impri_client.report_result(
                            action_id, "execute_failed", detail=str(exc)
                        )
                    except Exception:
                        pass
                    raise
            else:
                return self.wrapped_tool.run(effective)

        async def _arun(
            self,
            *args: Any,
            run_manager: Optional[Any] = None,
            **kwargs: Any,
        ) -> str:
            """Async variant — delegates to ``_run`` (synchronous blocking poll).

            For fully non-blocking async flows, use ``ImpriClient.await_decision``
            directly inside an ``asyncio`` coroutine with ``asyncio.sleep`` instead
            of ``time.sleep``.
            """
            return self._run(*args, run_manager=run_manager, **kwargs)

else:
    # Stub so the module imports cleanly without langchain-core.
    class ImpriApprovalTool:  # type: ignore[no-redef]
        """Stub — ``langchain-core`` is not installed."""

        @classmethod
        def wrap(cls, *args: Any, **kwargs: Any) -> "ImpriApprovalTool":
            raise ImportError(
                "langchain-core is required to use ImpriApprovalTool. "
                "Install it with:  pip install langchain-core"
            )

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            raise ImportError(
                "langchain-core is required to use ImpriApprovalTool. "
                "Install it with:  pip install langchain-core"
            )
