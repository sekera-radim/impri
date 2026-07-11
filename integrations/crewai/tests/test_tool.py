"""Light integration tests for impri_crewai.

All HTTP calls are intercepted via the injectable _transport parameter — no
network, no patching of stdlib internals.

CrewAI-dependent tests are collected only when crewai is installed, so the
suite passes cleanly in environments with only pytest + stdlib.
"""
from __future__ import annotations

import json
import time
from typing import Iterator, Optional, Tuple
from unittest.mock import patch

import pytest

from impri_crewai._client import ImpriClient
from impri_crewai._exceptions import (
    ImpriConflict,
    ImpriConfigError,
    ImpriExpired,
    ImpriRejected,
    ImpriTimeout,
    ImpriUnauthorized,
)

# Guard the crewai import — the ImpriApprovalTool tests are skipped when
# crewai is not installed rather than failing with an ImportError.
# We must check for crewai itself, not just the module import, because
# tool.py defines a stub ImpriApprovalTool that raises only on instantiation.
try:
    import crewai as _crewai_mod  # noqa: F401

    from impri_crewai.tool import ImpriApprovalTool

    _CREWAI_AVAILABLE = True
except ImportError:
    _CREWAI_AVAILABLE = False


# ---------------------------------------------------------------------------
# Transport helpers
# ---------------------------------------------------------------------------

def _resp(body: object, status: int = 200) -> Tuple[int, bytes]:
    """Build a (status, bytes) pair the mock transport returns."""
    return status, json.dumps(body).encode()


def _transport(*responses: Tuple[int, bytes]):
    """Return a transport callable that yields the given (status, bytes) in order.

    Extra calls beyond the supplied responses repeat the last one, so tests
    that poll in a loop don't need to supply a response per iteration.
    """
    seq = list(responses)

    def _call(
        method: str,
        url: str,
        headers: dict,
        body: Optional[bytes] = None,
    ) -> Tuple[int, bytes]:
        if len(seq) > 1:
            return seq.pop(0)
        return seq[0]  # repeat last response

    return _call


def _client(*responses: Tuple[int, bytes]) -> ImpriClient:
    """Create a test ImpriClient with a preloaded transport."""
    return ImpriClient(
        api_key="im_test_key",
        base_url="http://localhost:8484",
        _transport=_transport(*responses),
    )


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

class TestConfig:
    def test_raises_when_no_api_key(self):
        import os
        env = {k: v for k, v in os.environ.items() if k != "IMPRI_API_KEY"}
        with patch.dict(os.environ, env, clear=True):
            with pytest.raises(ImpriConfigError, match="No API key"):
                ImpriClient()

    def test_accepts_api_key_from_env(self):
        import os
        with patch.dict(os.environ, {"IMPRI_API_KEY": "im_from_env"}):
            c = ImpriClient()
        assert c._api_key == "im_from_env"

    def test_strips_trailing_slash_from_base_url(self):
        c = ImpriClient(api_key="im_x", base_url="http://localhost:8484/")
        assert c._base_url == "http://localhost:8484"


# ---------------------------------------------------------------------------
# create_action
# ---------------------------------------------------------------------------

class TestCreateAction:
    def test_returns_created_action(self):
        payload = {
            "id": "act_abc123",
            "status": "pending",
            "inbox_url": "http://localhost:8080/inbox/act_abc123",
            "expires_at": int(time.time()) + 3600,
            "created_at": int(time.time()),
        }
        c = _client(_resp(payload, 201))
        result = c.create_action(
            kind="email.send",
            title="Send email to alice@example.com",
            preview={"format": "plain", "body": "Hello Alice!"},
        )
        assert result["id"] == "act_abc123"
        assert result["status"] == "pending"

    def test_raises_unauthorized_on_401(self):
        c = _client(_resp({"message": "Invalid key"}, 401))
        with pytest.raises(ImpriUnauthorized):
            c.create_action("k", "t", {"format": "plain", "body": "b"})

    def test_raises_conflict_on_409(self):
        c = _client(_resp({"message": "Already decided"}, 409))
        with pytest.raises(ImpriConflict):
            c.get_action("act_already_done")


# ---------------------------------------------------------------------------
# await_decision polling loop
# ---------------------------------------------------------------------------

class TestAwaitDecision:
    def test_returns_action_on_first_poll_approved(self):
        approved = {
            "id": "act_1",
            "status": "approved",
            "decision": {
                "verdict": "approve",
                "decided_at": int(time.time()),
                "final_preview": {"format": "plain", "body": "Edited text"},
            },
        }
        c = _client(_resp(approved))
        result = c.await_decision("act_1")
        assert result["status"] == "approved"
        assert result["decision"]["final_preview"]["body"] == "Edited text"

    def test_polls_then_returns_on_approve(self):
        """One pending response followed by an approved response."""
        pending = {"id": "act_2", "status": "pending"}
        approved = {
            "id": "act_2",
            "status": "approved",
            "decision": {
                "verdict": "approve",
                "decided_at": int(time.time()),
                "final_preview": {"format": "plain", "body": "ok"},
            },
        }
        c = _client(_resp(pending), _resp(approved))
        with patch("time.sleep"):  # don't block the test suite
            result = c.await_decision("act_2", poll_interval_s=5)
        assert result["status"] == "approved"

    def test_raises_impri_rejected(self):
        rejected = {
            "id": "act_3",
            "status": "rejected",
            "decision": {
                "verdict": "reject",
                "decided_at": int(time.time()),
            },
        }
        c = _client(_resp(rejected))
        with pytest.raises(ImpriRejected) as exc_info:
            c.await_decision("act_3")
        assert exc_info.value.action_id == "act_3"
        assert exc_info.value.decision["verdict"] == "reject"

    def test_raises_impri_expired_on_status(self):
        c = _client(_resp({"id": "act_4", "status": "expired"}))
        with pytest.raises(ImpriExpired):
            c.await_decision("act_4")

    def test_raises_impri_timeout_when_deadline_passes(self):
        pending = {"id": "act_5", "status": "pending"}
        c = _client(_resp(pending))  # always returns pending
        monotonic_values = iter([0.0, 0.0, 999.0])
        with patch("time.sleep"):
            with patch("time.monotonic", side_effect=monotonic_values):
                with pytest.raises(ImpriTimeout) as exc_info:
                    c.await_decision("act_5", timeout_s=1.0, poll_interval_s=5)
        assert exc_info.value.action_id == "act_5"


# ---------------------------------------------------------------------------
# ImpriApprovalTool (skipped without crewai)
# ---------------------------------------------------------------------------

@pytest.mark.skipif(not _CREWAI_AVAILABLE, reason="crewai not installed")
class TestImpriApprovalTool:
    def _make_tool(self, *responses: Tuple[int, bytes]) -> "ImpriApprovalTool":
        return ImpriApprovalTool(
            client=_client(*responses),
            action_kind="test.action",
            timeout_s=30.0,
        )

    def test_run_returns_approved_content(self):
        created = {
            "id": "act_tool1",
            "status": "pending",
            "inbox_url": "http://localhost:8080/inbox/act_tool1",
        }
        approved = {
            "id": "act_tool1",
            "status": "approved",
            "decision": {
                "verdict": "approve",
                "decided_at": int(time.time()),
                "final_preview": {"format": "plain", "body": "Approved content here"},
            },
        }
        tool = self._make_tool(_resp(created, 201), _resp(approved))
        result = tool._run(
            action_title="Publish blog post",
            action_body="Draft body text",
            preview_format="plain",
        )
        assert "APPROVED" in result
        assert "Approved content here" in result

    def test_run_surfaces_edit_note_when_diff_present(self):
        created = {"id": "act_tool2", "status": "pending", "inbox_url": ""}
        approved = {
            "id": "act_tool2",
            "status": "approved",
            "decision": {
                "verdict": "approve",
                "decided_at": int(time.time()),
                "final_preview": {"format": "plain", "body": "Human revised this"},
                "diff": "@@ -1 +1 @@\n-Draft\n+Human revised this",
            },
        }
        tool = self._make_tool(_resp(created, 201), _resp(approved))
        result = tool._run("title", "Draft", "plain")
        assert "Human revised this" in result
        assert "human reviewer edited" in result.lower()

    def test_run_raises_impri_rejected(self):
        created = {"id": "act_tool3", "status": "pending", "inbox_url": ""}
        rejected = {
            "id": "act_tool3",
            "status": "rejected",
            "decision": {"verdict": "reject", "decided_at": int(time.time())},
        }
        tool = self._make_tool(_resp(created, 201), _resp(rejected))
        with pytest.raises(ImpriRejected):
            tool._run("Dangerous action", "DROP TABLE users", "plain")

    def test_tool_name_and_description_are_set(self):
        tool = ImpriApprovalTool(client=_client(_resp({})))
        assert tool.name == "impri_approval_gate"
        assert "approval" in tool.description.lower()


# ---------------------------------------------------------------------------
# Webhook signature verification
# ---------------------------------------------------------------------------

class TestVerifyWebhook:
    def test_valid_signature_passes(self):
        import hashlib
        import hmac as _hmac
        import time as _time

        from impri_crewai._client import verify_webhook

        secret = "whsec_test"
        # Use a fresh timestamp so the replay-protection window check passes.
        timestamp = str(int(_time.time()))
        nonce = "abc123"
        body = b'{"event":"action.decided"}'
        message = f"{timestamp}.{nonce}.".encode() + body
        sig = "sha256=" + _hmac.new(
            secret.encode(), message, hashlib.sha256
        ).hexdigest()

        verify_webhook(body, secret, timestamp, nonce, sig)  # must not raise

    def test_wrong_signature_raises(self):
        from impri_crewai._client import verify_webhook
        from impri_crewai._exceptions import ImpriWebhookSignatureError

        with pytest.raises(ImpriWebhookSignatureError):
            verify_webhook(b"body", "secret", "ts", "nonce", "sha256=baddigest")
