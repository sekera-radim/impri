"""Unit tests for ImpriClient and the error hierarchy.

Langchain is NOT required — these tests exercise _client.py and _errors.py
only, with urllib.request.urlopen mocked via unittest.mock.patch.

Run:
    python -m pytest integrations/langchain/tests/test_core.py -v
or from the integration directory:
    python -m pytest tests/ -v
"""
from __future__ import annotations

import io
import json
import os
import time
import unittest
import urllib.error
import urllib.request
from typing import Any
from unittest.mock import MagicMock, call, patch

# Path-independent imports: the integration ships as a package.
import sys
import pathlib

# Ensure the integrations/langchain package is importable when running the
# test directly from the repo root (python -m pytest ...) or from inside the
# integration directory.
_HERE = pathlib.Path(__file__).parent.parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE.parent))

from integrations.langchain._client import ImpriClient
from integrations.langchain._errors import (
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


# ── Test helpers ─────────────────────────────────────────────────────────────

def _json_response(data: dict[str, Any], status: int = 200) -> MagicMock:
    """Return a mock that behaves like urllib's HTTP response context manager."""
    raw = json.dumps(data).encode()
    mock = MagicMock()
    mock.read.return_value = raw
    mock.status = status
    mock.__enter__ = lambda s: s
    mock.__exit__ = MagicMock(return_value=False)
    return mock


def _http_error(status: int, body: dict[str, Any] | None = None, reason: str = "") -> urllib.error.HTTPError:
    """Build a urllib.error.HTTPError with a readable JSON body."""
    raw = json.dumps(body or {}).encode()
    headers = MagicMock()
    headers.get = MagicMock(return_value=None)
    return urllib.error.HTTPError(
        url="http://localhost:8484/v1/actions",
        code=status,
        msg=reason,
        hdrs=headers,
        fp=io.BytesIO(raw),
    )


def _make_client(api_key: str = "im_test") -> ImpriClient:
    return ImpriClient(api_key=api_key, base_url="http://localhost:8484")


# ── ImpriClient construction ──────────────────────────────────────────────────

class TestClientConstruction(unittest.TestCase):

    def test_explicit_key_accepted(self):
        client = _make_client("im_abc123")
        self.assertEqual(client._api_key, "im_abc123")

    def test_env_key_fallback(self):
        with patch.dict(os.environ, {"IMPRI_API_KEY": "im_from_env"}):
            client = ImpriClient()
            self.assertEqual(client._api_key, "im_from_env")

    def test_missing_key_raises_config_error(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(ImpriConfigError):
                ImpriClient()

    def test_base_url_trailing_slash_stripped(self):
        client = ImpriClient(api_key="im_x", base_url="https://api.impri.dev/")
        self.assertEqual(client._base, "https://api.impri.dev/v1")

    def test_default_base_url_is_localhost(self):
        with patch.dict(os.environ, {"IMPRI_API_KEY": "im_x"}, clear=True):
            with patch.dict(os.environ, {}, clear=False):
                # Remove IMPRI_BASE_URL if present
                env = {k: v for k, v in os.environ.items() if k != "IMPRI_BASE_URL"}
                with patch.dict(os.environ, env, clear=True):
                    client = ImpriClient(api_key="im_x")
                    self.assertEqual(client._base, "http://localhost:8484/v1")

    def test_base_url_env_fallback(self):
        with patch.dict(os.environ, {"IMPRI_BASE_URL": "https://api.impri.dev"}):
            client = ImpriClient(api_key="im_x")
            self.assertEqual(client._base, "https://api.impri.dev/v1")

    def test_config_error_is_impri_error(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(ImpriError):
                ImpriClient()


# ── create_action ─────────────────────────────────────────────────────────────

class TestCreateAction(unittest.TestCase):

    RESPONSE = {
        "id": "act_abc",
        "status": "pending",
        "inbox_url": "http://localhost:8080/inbox/act_abc",
        "expires_at": 1720086400,
        "created_at": 1720000000,
    }

    def test_post_to_correct_url(self):
        client = _make_client()
        with patch("urllib.request.urlopen", return_value=_json_response(self.RESPONSE)) as mock_open:
            client.create_action(
                kind="email.send",
                title="Send welcome email",
                preview={"format": "plain", "body": "Hello!"},
            )
        req: urllib.request.Request = mock_open.call_args[0][0]
        self.assertEqual(req.get_full_url(), "http://localhost:8484/v1/actions")
        self.assertEqual(req.get_method(), "POST")

    def test_returns_action_created_dict(self):
        client = _make_client()
        with patch("urllib.request.urlopen", return_value=_json_response(self.RESPONSE)):
            result = client.create_action(
                kind="email.send",
                title="Send welcome email",
                preview={"format": "plain", "body": "Hello!"},
            )
        self.assertEqual(result["id"], "act_abc")
        self.assertEqual(result["status"], "pending")
        self.assertIn("inbox_url", result)

    def test_bearer_token_in_header(self):
        client = _make_client("im_secret")
        with patch("urllib.request.urlopen", return_value=_json_response(self.RESPONSE)) as mock_open:
            client.create_action("k", "t", {"format": "plain", "body": "b"})
        req: urllib.request.Request = mock_open.call_args[0][0]
        self.assertEqual(req.get_header("Authorization"), "Bearer im_secret")

    def test_optional_fields_omitted_when_none(self):
        client = _make_client()
        captured: list[dict] = []

        def fake_open(req):
            captured.append(json.loads(req.data))
            return _json_response(self.RESPONSE)

        with patch("urllib.request.urlopen", side_effect=fake_open):
            client.create_action("k", "t", {"format": "plain", "body": "b"})

        body = captured[0]
        self.assertNotIn("payload", body)
        self.assertNotIn("target_url", body)
        self.assertNotIn("idempotency_key", body)

    def test_optional_fields_included_when_set(self):
        client = _make_client()
        captured: list[dict] = []

        def fake_open(req):
            captured.append(json.loads(req.data))
            return _json_response(self.RESPONSE)

        with patch("urllib.request.urlopen", side_effect=fake_open):
            client.create_action(
                kind="email.send",
                title="t",
                preview={"format": "plain", "body": "b"},
                payload={"draft_id": 42},
                target_url="https://example.com/draft/42",
                idempotency_key="batch-0710-1",
                editable=["preview.body"],
                expires_in=86400,
            )

        body = captured[0]
        self.assertEqual(body["payload"], {"draft_id": 42})
        self.assertEqual(body["target_url"], "https://example.com/draft/42")
        self.assertEqual(body["idempotency_key"], "batch-0710-1")
        self.assertEqual(body["editable"], ["preview.body"])
        self.assertEqual(body["expires_in"], 86400)


# ── get_action ────────────────────────────────────────────────────────────────

class TestGetAction(unittest.TestCase):

    APPROVED = {
        "id": "act_abc",
        "kind": "email.send",
        "title": "Send welcome email",
        "status": "approved",
        "preview": {"format": "plain", "body": "Hello!"},
        "decision": {
            "verdict": "approve",
            "decided_at": 1720003600,
            "final_preview": {"format": "plain", "body": "Hello, welcome!"},
            "diff": "@@ -1 +1 @@\n-Hello!\n+Hello, welcome!",
        },
        "created_at": 1720000000,
        "updated_at": 1720003600,
    }

    def test_get_to_correct_url(self):
        client = _make_client()
        with patch("urllib.request.urlopen", return_value=_json_response(self.APPROVED)) as mock_open:
            client.get_action("act_abc")
        req: urllib.request.Request = mock_open.call_args[0][0]
        self.assertIn("/actions/act_abc", req.get_full_url())
        self.assertEqual(req.get_method(), "GET")

    def test_returns_action_with_decision(self):
        client = _make_client()
        with patch("urllib.request.urlopen", return_value=_json_response(self.APPROVED)):
            action = client.get_action("act_abc")
        self.assertEqual(action["status"], "approved")
        self.assertIn("decision", action)
        self.assertEqual(action["decision"]["verdict"], "approve")


# ── report_result ─────────────────────────────────────────────────────────────

class TestReportResult(unittest.TestCase):

    RESPONSE = {"id": "act_abc", "status": "executed", "updated_at": 1720010000}

    def test_post_to_result_endpoint(self):
        client = _make_client()
        with patch("urllib.request.urlopen", return_value=_json_response(self.RESPONSE)) as mock_open:
            client.report_result("act_abc", "executed")
        req: urllib.request.Request = mock_open.call_args[0][0]
        self.assertIn("/actions/act_abc/result", req.get_full_url())
        self.assertEqual(req.get_method(), "POST")

    def test_body_contains_status(self):
        client = _make_client()
        captured: list[dict] = []

        def fake_open(req):
            captured.append(json.loads(req.data))
            return _json_response(self.RESPONSE)

        with patch("urllib.request.urlopen", side_effect=fake_open):
            client.report_result("act_abc", "execute_failed", detail="HTTP 500")

        self.assertEqual(captured[0]["status"], "execute_failed")
        self.assertEqual(captured[0]["detail"], "HTTP 500")

    def test_detail_omitted_when_none(self):
        client = _make_client()
        captured: list[dict] = []

        def fake_open(req):
            captured.append(json.loads(req.data))
            return _json_response(self.RESPONSE)

        with patch("urllib.request.urlopen", side_effect=fake_open):
            client.report_result("act_abc", "executed")

        self.assertNotIn("detail", captured[0])


# ── await_decision ────────────────────────────────────────────────────────────

class TestAwaitDecision(unittest.TestCase):

    PENDING = {"id": "act_abc", "status": "pending"}
    APPROVED = {
        "id": "act_abc",
        "status": "approved",
        "decision": {"verdict": "approve", "decided_at": 1720003600, "final_preview": None, "diff": None},
    }
    REJECTED = {
        "id": "act_abc",
        "status": "rejected",
        "decision": {"verdict": "reject", "decided_at": 1720003600, "final_preview": None, "diff": None},
    }
    EXPIRED = {"id": "act_abc", "status": "expired"}

    def test_returns_on_approval(self):
        responses = [_json_response(self.PENDING), _json_response(self.APPROVED)]
        client = _make_client()
        with patch("urllib.request.urlopen", side_effect=responses):
            with patch("time.sleep"):
                with patch("time.monotonic", side_effect=[0, 10, 20]):
                    action = client.await_decision("act_abc", timeout_s=300, poll_interval_s=5)
        self.assertEqual(action["status"], "approved")

    def test_raises_rejected(self):
        responses = [_json_response(self.REJECTED)]
        client = _make_client()
        with patch("urllib.request.urlopen", side_effect=responses):
            with patch("time.monotonic", side_effect=[0, 10]):
                with self.assertRaises(ImpriRejected) as ctx:
                    client.await_decision("act_abc", timeout_s=300)
        self.assertEqual(ctx.exception.action_id, "act_abc")

    def test_raises_expired(self):
        responses = [_json_response(self.EXPIRED)]
        client = _make_client()
        with patch("urllib.request.urlopen", side_effect=responses):
            with patch("time.monotonic", side_effect=[0, 10]):
                with self.assertRaises(ImpriExpired):
                    client.await_decision("act_abc", timeout_s=300)

    def test_raises_timeout_when_still_pending(self):
        # monotonic: deadline=0+300=300; remaining=300-301=-1 → timeout
        client = _make_client()
        with patch("urllib.request.urlopen", return_value=_json_response(self.PENDING)):
            with patch("time.sleep"):
                with patch("time.monotonic", side_effect=[0, 301]):
                    with self.assertRaises(ImpriTimeout) as ctx:
                        client.await_decision("act_abc", timeout_s=300, poll_interval_s=5)
        self.assertEqual(ctx.exception.action_id, "act_abc")

    def test_polls_until_decided(self):
        """Verify that the client polls multiple times before getting a decision."""
        responses = [
            _json_response(self.PENDING),
            _json_response(self.PENDING),
            _json_response(self.APPROVED),
        ]
        client = _make_client()
        with patch("urllib.request.urlopen", side_effect=responses) as mock_open:
            with patch("time.sleep"):
                with patch("time.monotonic", side_effect=[0, 5, 10, 15, 20]):
                    client.await_decision("act_abc", timeout_s=300, poll_interval_s=5)
        # Should have called urlopen 3 times (2 pending + 1 approved)
        self.assertEqual(mock_open.call_count, 3)

    def test_rejected_carries_decision(self):
        rejected = {
            "id": "act_abc",
            "status": "rejected",
            "decision": {
                "verdict": "reject",
                "decided_at": 1720003600,
                "final_preview": None,
                "diff": None,
            },
        }
        client = _make_client()
        with patch("urllib.request.urlopen", return_value=_json_response(rejected)):
            with patch("time.monotonic", side_effect=[0, 10]):
                with self.assertRaises(ImpriRejected) as ctx:
                    client.await_decision("act_abc", timeout_s=300)
        exc = ctx.exception
        self.assertEqual(exc.decision["verdict"], "reject")
        self.assertIsInstance(exc, ImpriError)


# ── HTTP error mapping ────────────────────────────────────────────────────────

class TestErrorMapping(unittest.TestCase):
    """Every HTTP status the spec calls out maps to the right exception."""

    def _call(self, status: int, body: dict | None = None) -> None:
        client = _make_client()
        with patch("urllib.request.urlopen", side_effect=_http_error(status, body or {})):
            client.get_action("act_abc")

    def test_401_raises_unauthorized(self):
        with self.assertRaises(ImpriUnauthorized):
            self._call(401)

    def test_403_raises_unauthorized(self):
        with self.assertRaises(ImpriUnauthorized):
            self._call(403)

    def test_402_raises_quota_exceeded(self):
        with self.assertRaises(ImpriQuotaExceeded) as ctx:
            self._call(402, {"message": "limit reached", "limit": 100, "tier": "free"})
        self.assertEqual(ctx.exception.limit, 100)
        self.assertEqual(ctx.exception.tier, "free")

    def test_404_raises_not_found(self):
        with self.assertRaises(ImpriNotFound):
            self._call(404)

    def test_409_raises_conflict(self):
        with self.assertRaises(ImpriConflict):
            self._call(409)

    def test_410_raises_expired(self):
        with self.assertRaises(ImpriExpired):
            self._call(410)

    def test_422_raises_validation_error(self):
        with self.assertRaises(ImpriValidationError) as ctx:
            self._call(422, {"message": "bad field", "issues": [{"field": "kind"}]})
        self.assertEqual(ctx.exception.issues, [{"field": "kind"}])

    def test_400_raises_validation_error(self):
        with self.assertRaises(ImpriValidationError):
            self._call(400)

    def test_429_raises_rate_limited(self):
        with self.assertRaises(ImpriRateLimited):
            self._call(429)

    def test_500_raises_api_error(self):
        with self.assertRaises(ImpriApiError) as ctx:
            self._call(500, {"message": "internal error"})
        self.assertEqual(ctx.exception.status_code, 500)

    def test_retry_after_parsed_from_header(self):
        client = _make_client()
        exc = _http_error(429, {})
        exc.headers.get = lambda key, *_: "30" if key == "Retry-After" else None
        with patch("urllib.request.urlopen", side_effect=exc):
            with self.assertRaises(ImpriRateLimited) as ctx:
                client.get_action("act_abc")
        self.assertEqual(ctx.exception.retry_after, 30)

    def test_all_errors_inherit_impri_error(self):
        """Callers can catch ImpriError as a single catch-all."""
        error_classes = [
            ImpriConfigError, ImpriUnauthorized, ImpriNotFound, ImpriConflict,
            ImpriExpired, ImpriRateLimited, ImpriQuotaExceeded, ImpriValidationError,
            ImpriApiError, ImpriRejected, ImpriTimeout,
        ]
        for cls in error_classes:
            with self.subTest(cls=cls.__name__):
                self.assertTrue(issubclass(cls, ImpriError))


# ── ImpriApprovalTool (no-langchain path) ────────────────────────────────────

class TestApprovalToolStub(unittest.TestCase):
    """The tool module loads without langchain; instantiation raises ImportError."""

    def test_module_imports_without_langchain(self):
        # If we get here, the import succeeded (langchain may or may not be installed).
        from integrations.langchain import tool as tool_module  # noqa: F401
        from integrations.langchain import ImpriApprovalTool  # noqa: F401

    def test_tool_class_is_importable(self):
        from integrations.langchain import ImpriApprovalTool
        self.assertIsNotNone(ImpriApprovalTool)


if __name__ == "__main__":
    unittest.main()
