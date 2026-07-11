"""Light tests for ImpriClient using mocked httpx.

Run with:  python -m pytest tests/test_client.py -v
"""
from __future__ import annotations

import asyncio
import json
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Guard: the package must import even when optional deps are absent
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from impri_openai import (
    ImpriClient,
    ImpriConfigError,
    ImpriConflict,
    ImpriExpired,
    ImpriNotFound,
    ImpriQuotaExceeded,
    ImpriRateLimited,
    ImpriRejected,
    ImpriTimeout,
    ImpriUnauthorized,
    ImpriValidationError,
    verify_webhook,
    ImpriWebhookSignatureError,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_response(status: int, body: dict | list | None = None, headers: dict | None = None):
    """Build a minimal fake httpx.Response."""
    resp = MagicMock()
    resp.status_code = status
    resp.is_success = 200 <= status < 300
    resp.headers = headers or {}
    body_bytes = json.dumps(body or {}).encode()
    resp.text = body_bytes.decode()
    resp.json = MagicMock(return_value=body or {})
    return resp


def _client_with_mock(mock_response) -> tuple[ImpriClient, MagicMock]:
    """Return an ImpriClient whose HTTP calls return mock_response."""
    mock_http = AsyncMock()
    mock_http.request = AsyncMock(return_value=mock_response)
    mock_http.aclose = AsyncMock()
    client = ImpriClient(api_key="im_test_key", http_client=mock_http)
    return client, mock_http


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------

class TestClientConstruction(unittest.TestCase):
    def test_raises_config_error_without_key(self):
        with self.assertRaises(ImpriConfigError):
            ImpriClient()  # no api_key, no env var

    def test_accepts_key_from_env(self):
        with patch.dict(os.environ, {"IMPRI_API_KEY": "im_from_env"}):
            c = ImpriClient()
            self.assertEqual(c._api_key, "im_from_env")

    def test_base_url_default(self):
        c = ImpriClient(api_key="im_x")
        self.assertEqual(c._base_url, "http://localhost:8484")

    def test_base_url_trailing_slash_stripped(self):
        c = ImpriClient(api_key="im_x", base_url="https://api.impri.dev/")
        self.assertEqual(c._base_url, "https://api.impri.dev")

    def test_base_url_from_env(self):
        with patch.dict(os.environ, {"IMPRI_API_KEY": "im_x", "IMPRI_BASE_URL": "https://api.impri.dev"}):
            c = ImpriClient()
            self.assertEqual(c._base_url, "https://api.impri.dev")


# ---------------------------------------------------------------------------
# create_action
# ---------------------------------------------------------------------------

class TestCreateAction(unittest.IsolatedAsyncioTestCase):
    async def test_success_returns_dict(self):
        payload = {
            "id": "act_abc",
            "status": "pending",
            "inbox_url": "https://app.impri.dev/inbox/act_abc",
            "expires_at": 9999999999,
            "created_at": 1000000000,
        }
        resp = _make_response(201, payload)
        client, mock_http = _client_with_mock(resp)

        result = await client.create_action(
            "email.send",
            "Send welcome email",
            {"format": "plain", "body": "Hello!"},
        )

        self.assertEqual(result["id"], "act_abc")
        self.assertEqual(result["status"], "pending")
        # Verify Authorization header was sent
        call_kwargs = mock_http.request.call_args
        assert "Bearer im_test_key" in call_kwargs.kwargs.get("headers", {}).get("Authorization", "")

    async def test_forwards_optional_fields(self):
        resp = _make_response(201, {"id": "act_xyz", "status": "pending", "inbox_url": ""})
        client, mock_http = _client_with_mock(resp)

        await client.create_action(
            "email.send",
            "Title",
            {"format": "plain", "body": "body"},
            payload={"foo": "bar"},
            target_url="https://example.com",
            expires_in=3600,
            idempotency_key="idem-1",
            editable=["preview.body"],
        )

        # httpx receives a dict for the json= kwarg; it serialises it internally
        json_kwarg = mock_http.request.call_args.kwargs.get("json") or {}
        self.assertEqual(json_kwarg.get("idempotency_key"), "idem-1")
        self.assertEqual(json_kwarg.get("editable"), ["preview.body"])
        self.assertEqual(json_kwarg.get("target_url"), "https://example.com")
        self.assertEqual(json_kwarg.get("expires_in"), 3600)

    async def test_unauthorized_raises(self):
        resp = _make_response(403, {"message": 'Scope "actions" required'})
        client, _ = _client_with_mock(resp)
        with self.assertRaises(ImpriUnauthorized):
            await client.create_action("k", "t", {"format": "plain", "body": "b"})

    async def test_quota_exceeded_raises(self):
        resp = _make_response(402, {"message": "quota", "limit": 100, "tier": "free"})
        client, _ = _client_with_mock(resp)
        with self.assertRaises(ImpriQuotaExceeded) as ctx:
            await client.create_action("k", "t", {"format": "plain", "body": "b"})
        self.assertEqual(ctx.exception.limit, 100)
        self.assertEqual(ctx.exception.tier, "free")

    async def test_rate_limited_carries_retry_after(self):
        resp = _make_response(429, {"message": "slow down"}, headers={"Retry-After": "5"})
        client, _ = _client_with_mock(resp)
        with self.assertRaises(ImpriRateLimited) as ctx:
            await client.create_action("k", "t", {"format": "plain", "body": "b"})
        self.assertEqual(ctx.exception.retry_after, 5)

    async def test_validation_error_carries_issues(self):
        issues = [{"code": "too_small", "path": ["expires_in"]}]
        resp = _make_response(422, {"message": "bad", "issues": issues})
        client, _ = _client_with_mock(resp)
        with self.assertRaises(ImpriValidationError) as ctx:
            await client.create_action("k", "t", {"format": "plain", "body": "b"})
        self.assertEqual(ctx.exception.issues, issues)


# ---------------------------------------------------------------------------
# get_action
# ---------------------------------------------------------------------------

class TestGetAction(unittest.IsolatedAsyncioTestCase):
    async def test_success_sets_is_untrusted_false(self):
        resp = _make_response(200, {
            "id": "act_1", "status": "pending",
            "kind": "test", "title": "t",
            "preview": {"format": "plain", "body": "b"},
            "payload": {"data": "x"},
        })
        client, _ = _client_with_mock(resp)
        action = await client.get_action("act_1")
        self.assertFalse(action["is_untrusted"])

    async def test_watcher_payload_sets_is_untrusted_true(self):
        resp = _make_response(200, {
            "id": "act_2", "status": "pending",
            "kind": "rss.item", "title": "t",
            "preview": {"format": "plain", "body": "b"},
            "payload": {"untrusted": True, "url": "https://x.com"},
        })
        client, _ = _client_with_mock(resp)
        action = await client.get_action("act_2")
        self.assertTrue(action["is_untrusted"])

    async def test_not_found_raises(self):
        resp = _make_response(404, {"message": "not found"})
        client, _ = _client_with_mock(resp)
        with self.assertRaises(ImpriNotFound):
            await client.get_action("act_missing")

    async def test_204_returns_none(self):
        resp = _make_response(204)
        client, _ = _client_with_mock(resp)
        result = await client._parse_response(resp)
        self.assertIsNone(result)


# ---------------------------------------------------------------------------
# await_decision
# ---------------------------------------------------------------------------

class TestAwaitDecision(unittest.IsolatedAsyncioTestCase):
    async def _client_sequence(self, responses: list) -> ImpriClient:
        """Client whose requests return responses in sequence."""
        mock_http = AsyncMock()
        mock_http.request = AsyncMock(side_effect=responses)
        mock_http.aclose = AsyncMock()
        return ImpriClient(api_key="im_x", http_client=mock_http)

    async def test_approved_returns_action(self):
        pending = _make_response(200, {
            "id": "act_1", "status": "pending",
            "kind": "k", "title": "t",
            "preview": {"format": "plain", "body": "b"},
        })
        approved = _make_response(200, {
            "id": "act_1", "status": "approved",
            "kind": "k", "title": "t",
            "preview": {"format": "plain", "body": "b"},
            "decision": {"verdict": "approve", "decided_at": 999, "final_preview": None},
        })
        client = await self._client_sequence([pending, approved])
        action = await client.await_decision("act_1", poll_interval_s=0.01)
        self.assertEqual(action["status"], "approved")

    async def test_rejected_raises_impri_rejected(self):
        rejected = _make_response(200, {
            "id": "act_2", "status": "rejected",
            "kind": "k", "title": "t",
            "preview": {"format": "plain", "body": "b"},
            "decision": {"verdict": "reject", "decided_at": 999},
        })
        client = await self._client_sequence([rejected])
        with self.assertRaises(ImpriRejected) as ctx:
            await client.await_decision("act_2", poll_interval_s=0.01)
        self.assertEqual(ctx.exception.action_id, "act_2")

    async def test_expired_raises_impri_expired(self):
        expired = _make_response(200, {
            "id": "act_3", "status": "expired",
            "kind": "k", "title": "t",
            "preview": {"format": "plain", "body": "b"},
        })
        client = await self._client_sequence([expired])
        with self.assertRaises(ImpriExpired):
            await client.await_decision("act_3", poll_interval_s=0.01)

    async def test_timeout_raises_impri_timeout(self):
        # Keep returning pending; timeout_s is tiny
        pending = _make_response(200, {
            "id": "act_4", "status": "pending",
            "kind": "k", "title": "t",
            "preview": {"format": "plain", "body": "b"},
        })
        mock_http = AsyncMock()
        mock_http.request = AsyncMock(return_value=pending)
        mock_http.aclose = AsyncMock()
        client = ImpriClient(api_key="im_x", http_client=mock_http)

        with self.assertRaises(ImpriTimeout) as ctx:
            await client.await_decision("act_4", timeout_s=0.05, poll_interval_s=0.01)
        self.assertEqual(ctx.exception.action_id, "act_4")

    async def test_conflict_on_decide_raises(self):
        resp = _make_response(409, {"message": "already decided"})
        client, _ = _client_with_mock(resp)
        with self.assertRaises(ImpriConflict):
            await client.decide("act_5", "approve")


# ---------------------------------------------------------------------------
# requires_approval decorator
# ---------------------------------------------------------------------------

class TestRequiresApproval(unittest.IsolatedAsyncioTestCase):
    def _make_client(self, action_id: str, final_body: str | None = None) -> ImpriClient:
        """Client that creates an action and immediately returns approved."""
        created_resp = _make_response(201, {
            "id": action_id,
            "status": "pending",
            "inbox_url": f"https://app.impri.dev/inbox/{action_id}",
        })

        decision = {"verdict": "approve", "decided_at": 1}
        if final_body is not None:
            decision["final_preview"] = {"format": "plain", "body": final_body}

        approved_resp = _make_response(200, {
            "id": action_id,
            "status": "approved",
            "kind": "k", "title": "t",
            "preview": {"format": "plain", "body": "original"},
            "decision": decision,
        })

        mock_http = AsyncMock()
        mock_http.request = AsyncMock(side_effect=[created_resp, approved_resp])
        mock_http.aclose = AsyncMock()
        return ImpriClient(api_key="im_x", http_client=mock_http)

    async def test_approved_calls_wrapped_function(self):
        client = self._make_client("act_ok")
        called_with: dict = {}

        @client.requires_approval(kind="test", title="Test action")
        async def my_fn(x: int, y: str) -> str:
            called_with.update({"x": x, "y": y})
            return "done"

        result = await my_fn(42, "hello")
        self.assertEqual(result, "done")
        self.assertEqual(called_with, {"x": 42, "y": "hello"})

    async def test_rejected_raises_without_calling_fn(self):
        rejected_resp = _make_response(200, {
            "id": "act_rej",
            "status": "rejected",
            "kind": "k", "title": "t",
            "preview": {"format": "plain", "body": "b"},
            "decision": {"verdict": "reject", "decided_at": 1},
        })
        created_resp = _make_response(201, {
            "id": "act_rej", "status": "pending", "inbox_url": ""
        })
        mock_http = AsyncMock()
        mock_http.request = AsyncMock(side_effect=[created_resp, rejected_resp])
        mock_http.aclose = AsyncMock()
        client = ImpriClient(api_key="im_x", http_client=mock_http)

        fn_called = False

        @client.requires_approval(kind="test", title="Title")
        async def guarded() -> None:
            nonlocal fn_called
            fn_called = True

        with self.assertRaises(ImpriRejected):
            await guarded()
        self.assertFalse(fn_called)

    async def test_injects_edited_body_when_editable(self):
        """When reviewer edits preview.body, the decorator injects the new body."""
        client = self._make_client("act_edit", final_body="Edited body text")
        received_body: list[str] = []

        @client.requires_approval(
            kind="test",
            title="t",
            preview=lambda body, **_: {"format": "plain", "body": body},
            editable=["preview.body"],
        )
        async def fn_with_body(body: str) -> str:
            received_body.append(body)
            return "ok"

        await fn_with_body("Original body text")
        self.assertEqual(received_body, ["Edited body text"])

    async def test_callable_title(self):
        """Title can be a lambda over function args."""
        created_resp = _make_response(201, {
            "id": "act_t", "status": "pending", "inbox_url": ""
        })
        approved_resp = _make_response(200, {
            "id": "act_t", "status": "approved",
            "kind": "k", "title": "t",
            "preview": {"format": "plain", "body": "b"},
            "decision": {"verdict": "approve", "decided_at": 1},
        })
        mock_http = AsyncMock()
        mock_http.request = AsyncMock(side_effect=[created_resp, approved_resp])
        mock_http.aclose = AsyncMock()
        client = ImpriClient(api_key="im_x", http_client=mock_http)

        @client.requires_approval(
            kind="email.send",
            title=lambda to, **_: f"Send email to {to}",
        )
        async def send_email(to: str) -> str:
            return "sent"

        await send_email("alice@example.com")

        # The second call (GET action) — check first call (POST) sent the right title
        first_call_json = mock_http.request.call_args_list[0].kwargs.get("json") or {}
        self.assertEqual(first_call_json.get("title"), "Send email to alice@example.com")


# ---------------------------------------------------------------------------
# approval_gate context manager
# ---------------------------------------------------------------------------

class TestApprovalGate(unittest.IsolatedAsyncioTestCase):
    def _make_client(self, action_id: str = "act_g") -> tuple[ImpriClient, AsyncMock]:
        created = _make_response(201, {"id": action_id, "status": "pending", "inbox_url": ""})
        approved = _make_response(200, {
            "id": action_id, "status": "approved",
            "kind": "k", "title": "t",
            "preview": {"format": "plain", "body": "original"},
            "decision": {"verdict": "approve", "decided_at": 1, "final_preview": None},
        })
        # report_result response
        result_ack = _make_response(200, {"id": action_id, "status": "executed", "updated_at": 2})

        mock_http = AsyncMock()
        mock_http.request = AsyncMock(side_effect=[created, approved, result_ack])
        mock_http.aclose = AsyncMock()
        client = ImpriClient(api_key="im_x", http_client=mock_http)
        return client, mock_http

    async def test_approved_yields_approved_action(self):
        client, mock_http = self._make_client("act_g1")
        async with client.approval_gate(
            "db.exec", "DROP TABLE", {"format": "plain", "body": "sql"}
        ) as approved:
            self.assertEqual(approved.action_id, "act_g1")
            self.assertIsNotNone(approved.decision)

        # Verify report_result was called with 'executed'
        last_call = mock_http.request.call_args_list[-1]
        self.assertIn("/result", last_call.args[1])
        json_body = last_call.kwargs.get("json") or {}
        self.assertEqual(json_body.get("status"), "executed")

    async def test_execute_failed_on_exception(self):
        client, mock_http = self._make_client("act_g2")

        with self.assertRaises(RuntimeError):
            async with client.approval_gate(
                "db.exec", "DROP TABLE", {"format": "plain", "body": "sql"}
            ) as _approved:
                raise RuntimeError("downstream failure")

        last_call = mock_http.request.call_args_list[-1]
        json_body = last_call.kwargs.get("json") or {}
        self.assertEqual(json_body.get("status"), "execute_failed")
        self.assertIn("downstream failure", json_body.get("detail", ""))

    async def test_rejected_raises_before_yield(self):
        created = _make_response(201, {"id": "act_g3", "status": "pending", "inbox_url": ""})
        rejected = _make_response(200, {
            "id": "act_g3", "status": "rejected",
            "kind": "k", "title": "t",
            "preview": {"format": "plain", "body": "b"},
            "decision": {"verdict": "reject", "decided_at": 1},
        })
        mock_http = AsyncMock()
        mock_http.request = AsyncMock(side_effect=[created, rejected])
        mock_http.aclose = AsyncMock()
        client = ImpriClient(api_key="im_x", http_client=mock_http)

        entered = False
        with self.assertRaises(ImpriRejected):
            async with client.approval_gate(
                "db.exec", "DROP TABLE", {"format": "plain", "body": "sql"}
            ) as _:
                entered = True

        self.assertFalse(entered)
        # report_result should NOT have been called (only create + get)
        self.assertEqual(mock_http.request.call_count, 2)


# ---------------------------------------------------------------------------
# verify_webhook
# ---------------------------------------------------------------------------

class TestVerifyWebhook(unittest.TestCase):
    def _make_sig(self, secret: str, timestamp: str, nonce: str, body: bytes) -> str:
        import hashlib
        import hmac as hmac_mod
        payload = f"{timestamp}.{nonce}.".encode() + body
        mac = hmac_mod.new(secret.encode(), payload, hashlib.sha256)
        return f"sha256={mac.hexdigest()}"

    def test_valid_signature_passes(self):
        secret, ts, nonce, body = "s3cr3t", "1720000000", "abc123", b'{"event":"decision"}'
        sig = self._make_sig(secret, ts, nonce, body)
        # Should not raise
        verify_webhook(body, secret, ts, nonce, sig)

    def test_valid_signature_with_str_body(self):
        secret, ts, nonce = "s3cr3t", "1720000000", "abc123"
        body_str = '{"event":"decision"}'
        sig = self._make_sig(secret, ts, nonce, body_str.encode())
        verify_webhook(body_str, secret, ts, nonce, sig)

    def test_wrong_secret_raises(self):
        ts, nonce, body = "1720000000", "abc123", b"body"
        sig = self._make_sig("correct_secret", ts, nonce, body)
        with self.assertRaises(ImpriWebhookSignatureError):
            verify_webhook(body, "wrong_secret", ts, nonce, sig)

    def test_tampered_body_raises(self):
        secret, ts, nonce = "s3cr3t", "1720000000", "abc123"
        sig = self._make_sig(secret, ts, nonce, b"original")
        with self.assertRaises(ImpriWebhookSignatureError):
            verify_webhook(b"tampered", secret, ts, nonce, sig)

    def test_empty_secret_raises(self):
        with self.assertRaises(ImpriWebhookSignatureError):
            verify_webhook(b"body", "", "ts", "nonce", "sha256=abc")

    def test_bad_prefix_raises(self):
        with self.assertRaises(ImpriWebhookSignatureError):
            verify_webhook(b"body", "secret", "ts", "nonce", "md5=abc")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
