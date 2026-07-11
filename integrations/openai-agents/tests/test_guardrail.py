"""Tests for the OpenAI Agents SDK guardrail integration.

The openai-agents package is optional — all imports from it are guarded.
Tests that require the SDK are skipped automatically when it's absent.
"""
from __future__ import annotations

import sys
import os
import unittest
from unittest.mock import AsyncMock, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Guard: check if openai-agents is available
try:
    import agents as _agents_pkg  # noqa: F401
    _AGENTS_AVAILABLE = True
except ImportError:
    _AGENTS_AVAILABLE = False

from impri_openai import ImpriClient, ImpriRejected
from impri_openai._guardrail import make_guardrail, _AGENTS_AVAILABLE as _GA


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_response(status: int, body: dict | None = None):
    import json
    resp = MagicMock()
    resp.status_code = status
    resp.is_success = 200 <= status < 300
    resp.headers = {}
    resp.text = json.dumps(body or {})
    resp.json = MagicMock(return_value=body or {})
    return resp


def _mock_client(action_id: str, verdict: str = "approve") -> ImpriClient:
    """Return an ImpriClient that creates an action and immediately returns a decision."""
    created = _make_response(201, {
        "id": action_id, "status": "pending", "inbox_url": ""
    })

    decision = {"verdict": verdict, "decided_at": 1}
    action_status = "approved" if verdict == "approve" else "rejected"
    get_action = _make_response(200, {
        "id": action_id,
        "status": action_status,
        "kind": "agent.run",
        "title": "test",
        "preview": {"format": "plain", "body": "input"},
        "decision": decision,
    })

    mock_http = AsyncMock()
    mock_http.request = AsyncMock(side_effect=[created, get_action])
    mock_http.aclose = AsyncMock()
    return ImpriClient(api_key="im_test", http_client=mock_http)


# ---------------------------------------------------------------------------
# Import guard test (always runs, SDK not needed)
# ---------------------------------------------------------------------------

class TestMakeGuardrailImportGuard(unittest.TestCase):
    def test_raises_import_error_when_sdk_absent(self):
        """make_guardrail raises ImportError with install instructions when SDK is absent."""
        if _AGENTS_AVAILABLE:
            self.skipTest("openai-agents is installed; skip the absence test")

        client = ImpriClient(api_key="im_x")
        with self.assertRaises(ImportError) as ctx:
            make_guardrail(client)
        self.assertIn("openai-agents", str(ctx.exception))
        self.assertIn("pip install", str(ctx.exception))

    def test_succeeds_when_sdk_present(self):
        """make_guardrail returns a non-None value when SDK is available."""
        if not _AGENTS_AVAILABLE:
            self.skipTest("openai-agents not installed")

        client = ImpriClient(api_key="im_x")
        guardrail = make_guardrail(client, kind="test", title="Title")
        self.assertIsNotNone(guardrail)


# ---------------------------------------------------------------------------
# Guardrail function behaviour (requires SDK)
# ---------------------------------------------------------------------------

@unittest.skipUnless(_AGENTS_AVAILABLE, "openai-agents not installed")
class TestGuardrailBehaviour(unittest.IsolatedAsyncioTestCase):
    """Exercises the guardrail function itself by calling it directly."""

    def _extract_fn(self, guardrail) -> object:
        """Pull the inner guardrail_function out of the InputGuardrail wrapper."""
        # The openai-agents SDK stores the function as .guardrail_function
        return guardrail.guardrail_function

    async def test_approved_returns_not_tripped(self):
        from agents import RunContextWrapper

        client = _mock_client("act_approve", "approve")
        guardrail = make_guardrail(client, kind="agent.run", title="Approve")
        fn = self._extract_fn(guardrail)

        fake_ctx = MagicMock(spec=RunContextWrapper)
        fake_agent = MagicMock()
        fake_agent.name = "test-agent"

        result = await fn(fake_ctx, fake_agent, "Please summarise my emails")

        self.assertFalse(result.tripwire_triggered)
        self.assertEqual(result.output_info["verdict"], "approve")
        self.assertEqual(result.output_info["action_id"], "act_approve")

    async def test_rejected_trips_guardrail(self):
        from agents import RunContextWrapper

        client = _mock_client("act_reject", "reject")
        guardrail = make_guardrail(client, kind="agent.run", title="Reject")
        fn = self._extract_fn(guardrail)

        fake_ctx = MagicMock(spec=RunContextWrapper)
        fake_agent = MagicMock()
        fake_agent.name = "test-agent"

        result = await fn(fake_ctx, fake_agent, "Do something dangerous")

        self.assertTrue(result.tripwire_triggered)
        self.assertEqual(result.output_info["verdict"], "reject")

    async def test_preview_body_from_string_input(self):
        """When input is a plain string it becomes the preview body."""
        from agents import RunContextWrapper

        # Capture what was sent to create_action
        sent_preview: list[dict] = []
        original_create = None

        client = _mock_client("act_prev", "approve")
        original_create = client.create_action

        async def capture_create(kind, title, preview, **kwargs):
            sent_preview.append(preview)
            return await original_create(kind, title, preview, **kwargs)

        client.create_action = capture_create  # type: ignore[method-assign]

        guardrail = make_guardrail(client, kind="agent.run", title="Title")
        fn = self._extract_fn(guardrail)

        fake_ctx = MagicMock(spec=RunContextWrapper)
        fake_agent = MagicMock()
        fake_agent.name = "agent"

        await fn(fake_ctx, fake_agent, "Hello from user")

        self.assertEqual(len(sent_preview), 1)
        self.assertEqual(sent_preview[0]["body"], "Hello from user")

    async def test_preview_body_from_message_list(self):
        """When input is a list of message dicts, text is extracted."""
        from agents import RunContextWrapper

        sent_preview: list[dict] = []
        client = _mock_client("act_list", "approve")
        original_create = client.create_action

        async def capture_create(kind, title, preview, **kwargs):
            sent_preview.append(preview)
            return await original_create(kind, title, preview, **kwargs)

        client.create_action = capture_create  # type: ignore[method-assign]

        guardrail = make_guardrail(client, kind="agent.run", title="Title")
        fn = self._extract_fn(guardrail)

        fake_ctx = MagicMock(spec=RunContextWrapper)
        fake_agent = MagicMock()
        fake_agent.name = "agent"

        input_messages = [
            {"role": "user", "content": "First line"},
            {"role": "user", "content": "Second line"},
        ]
        await fn(fake_ctx, fake_agent, input_messages)

        self.assertIn("First line", sent_preview[0]["body"])
        self.assertIn("Second line", sent_preview[0]["body"])

    async def test_guardrail_name_includes_kind(self):
        client = ImpriClient(api_key="im_x")
        guardrail = make_guardrail(client, kind="custom.kind", title="t")
        self.assertIn("custom.kind", guardrail.name)


if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])
