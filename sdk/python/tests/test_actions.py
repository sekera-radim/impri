"""Unit tests for action-related ImpriClient methods.

All HTTP calls go through MockTransport — no real network required.
"""
from __future__ import annotations

import json
import time
import unittest
from unittest.mock import patch

from impri import (
    ImpriClient,
    ImpriConflict,
    ImpriExpired,
    ImpriNotFound,
    ImpriRejected,
    ImpriTimeout,
    ImpriUnauthorized,
    ImpriValidationError,
    ImpriRateLimited,
)
from .mock_transport import MockTransport

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

API_KEY = "im_testkey123"

ACTION_CREATED = {
    "id": "act_abc",
    "status": "pending",
    "inbox_url": "http://localhost:8484/inbox/act_abc",
    "expires_at": 9999999999,
    "created_at": 1700000000,
}

ACTION_PENDING = {
    "id": "act_abc",
    "kind": "email.send",
    "title": "Send email to alice",
    "status": "pending",
    "preview": {"format": "plain", "body": "Hello Alice"},
    "editable": ["preview.body"],
    "created_at": 1700000000,
    "updated_at": 1700000000,
}

ACTION_APPROVED = {
    **ACTION_PENDING,
    "status": "approved",
    "decision": {
        "verdict": "approve",
        "decided_at": 1700001000,
        "channel": "web",
        "final_preview": {"format": "plain", "body": "Hello Alice (edited)"},
        "diff": "--- original\n+++ edited\n",
    },
}

ACTION_REJECTED = {
    **ACTION_PENDING,
    "status": "rejected",
    "decision": {
        "verdict": "reject",
        "decided_at": 1700001000,
        "channel": "web",
    },
}

ACTION_EXPIRED = {
    **ACTION_PENDING,
    "status": "expired",
}

RESULT_ACK = {
    "id": "act_abc",
    "status": "executed",
    "updated_at": 1700002000,
}


def make_client(*responses):
    transport = MockTransport(list(responses))
    return ImpriClient(api_key=API_KEY, _transport=transport), transport


# ---------------------------------------------------------------------------
# create_action
# ---------------------------------------------------------------------------

class TestCreateAction(unittest.TestCase):

    def test_sends_correct_method_and_path(self):
        client, t = make_client((201, ACTION_CREATED))
        client.create_action(
            kind="email.send",
            title="Send email to alice",
            preview={"format": "plain", "body": "Hello Alice"},
        )
        self.assertEqual(t.calls[0]["method"], "POST")
        self.assertEqual(t.calls[0]["path"], "/v1/actions")

    def test_sends_bearer_auth(self):
        client, t = make_client((201, ACTION_CREATED))
        client.create_action(
            kind="email.send",
            title="Test",
            preview={"format": "plain", "body": ""},
        )
        self.assertEqual(t.calls[0]["headers"]["Authorization"], f"Bearer {API_KEY}")

    def test_body_fields_mapped_correctly(self):
        client, t = make_client((201, ACTION_CREATED))
        client.create_action(
            kind="email.send",
            title="Send email to alice",
            preview={"format": "plain", "body": "Hello Alice"},
            payload={"to": "alice@example.com"},
            target_url="https://example.com",
            callback_url="https://myserver.example.com/webhook",
            expires_in=3600,
            idempotency_key="batch-1",
            editable=["preview.body"],
        )
        body = t.calls[0]["body"]
        self.assertEqual(body["kind"], "email.send")
        self.assertEqual(body["title"], "Send email to alice")
        self.assertEqual(body["preview"]["format"], "plain")
        self.assertEqual(body["preview"]["body"], "Hello Alice")
        self.assertEqual(body["payload"], {"to": "alice@example.com"})
        self.assertEqual(body["target_url"], "https://example.com")
        self.assertEqual(body["callback_url"], "https://myserver.example.com/webhook")
        self.assertEqual(body["expires_in"], 3600)
        self.assertEqual(body["idempotency_key"], "batch-1")
        self.assertEqual(body["editable"], ["preview.body"])

    def test_auto_idempotency_key_generated_when_omitted(self):
        client, t = make_client((201, ACTION_CREATED))
        client.create_action(
            kind="email.send",
            title="Test",
            preview={"format": "plain", "body": "body"},
        )
        key = t.calls[0]["body"]["idempotency_key"]
        self.assertIsNotNone(key)
        self.assertTrue(key.startswith("sdk_"))

    def test_auto_idempotency_key_stable_within_same_call(self):
        # Two clients with same params should produce the same key within the same process/day.
        client1, t1 = make_client((201, ACTION_CREATED))
        client2, t2 = make_client((201, ACTION_CREATED))
        kwargs = dict(kind="k", title="t", preview={"format": "plain", "body": "b"})
        client1.create_action(**kwargs)
        client2.create_action(**kwargs)
        self.assertEqual(t1.calls[0]["body"]["idempotency_key"],
                         t2.calls[0]["body"]["idempotency_key"])

    def test_returns_action_created(self):
        client, _ = make_client((201, ACTION_CREATED))
        result = client.create_action(
            kind="email.send",
            title="Test",
            preview={"format": "plain", "body": ""},
        )
        self.assertEqual(result["id"], "act_abc")
        self.assertEqual(result["status"], "pending")

    def test_duplicate_of_present_on_200(self):
        response = {**ACTION_CREATED, "duplicate_of": "act_old"}
        client, _ = make_client((200, response))
        result = client.create_action(
            kind="email.send",
            title="Test",
            preview={"format": "plain", "body": ""},
            idempotency_key="existing-key",
        )
        self.assertEqual(result["duplicate_of"], "act_old")

    def test_optional_fields_omitted_from_body_when_none(self):
        client, t = make_client((201, ACTION_CREATED))
        client.create_action(
            kind="k",
            title="t",
            preview={"format": "plain", "body": ""},
        )
        body = t.calls[0]["body"]
        self.assertNotIn("payload", body)
        self.assertNotIn("target_url", body)
        self.assertNotIn("callback_url", body)

    def test_raises_unauthorized_on_403(self):
        client, _ = make_client((403, {"error": "Forbidden", "message": "Scope \"actions\" required"}))
        with self.assertRaises(ImpriUnauthorized):
            client.create_action(kind="k", title="t", preview={"format": "plain", "body": ""})

    def test_raises_validation_error_on_400(self):
        client, _ = make_client((400, {"error": "Bad Request", "issues": [{"code": "too_small"}]}))
        with self.assertRaises(ImpriValidationError) as ctx:
            client.create_action(kind="k", title="t", preview={"format": "plain", "body": ""})
        self.assertEqual(len(ctx.exception.issues), 1)

    def test_raises_rate_limited_on_429(self):
        client, _ = make_client((429, {"error": "Too Many Requests", "message": "Rate limit: 60 requests/min"}))
        with self.assertRaises(ImpriRateLimited):
            client.create_action(kind="k", title="t", preview={"format": "plain", "body": ""})


# ---------------------------------------------------------------------------
# get_action
# ---------------------------------------------------------------------------

class TestGetAction(unittest.TestCase):

    def test_sends_correct_method_and_path(self):
        client, t = make_client((200, ACTION_APPROVED))
        client.get_action("act_abc")
        self.assertEqual(t.calls[0]["method"], "GET")
        self.assertEqual(t.calls[0]["path"], "/v1/actions/act_abc")

    def test_returns_deserialized_action(self):
        client, _ = make_client((200, ACTION_APPROVED))
        action = client.get_action("act_abc")
        self.assertEqual(action["id"], "act_abc")
        self.assertEqual(action["status"], "approved")
        self.assertEqual(action["decision"]["verdict"], "approve")

    def test_is_untrusted_false_by_default(self):
        client, _ = make_client((200, {**ACTION_PENDING, "payload": {"data": "x"}}))
        action = client.get_action("act_abc")
        self.assertFalse(action["is_untrusted"])

    def test_is_untrusted_true_for_watcher_items(self):
        client, _ = make_client((200, {**ACTION_PENDING, "payload": {"untrusted": True, "url": "https://example.com"}}))
        action = client.get_action("act_abc")
        self.assertTrue(action["is_untrusted"])

    def test_raises_not_found_on_404(self):
        client, _ = make_client((404, {"error": "Not Found"}))
        with self.assertRaises(ImpriNotFound):
            client.get_action("act_missing")


# ---------------------------------------------------------------------------
# list_actions
# ---------------------------------------------------------------------------

class TestListActions(unittest.TestCase):

    def test_sends_correct_method_and_path(self):
        client, t = make_client((200, {"items": [], "has_more": False}))
        client.list_actions()
        self.assertEqual(t.calls[0]["method"], "GET")
        self.assertEqual(t.calls[0]["path"], "/v1/actions")

    def test_passes_filter_params_in_query(self):
        client, t = make_client((200, {"items": [], "has_more": False}))
        client.list_actions(status="pending", kind="email.send", since=1700000000, limit=10)
        q = t.calls[0]["query"]
        self.assertEqual(q["status"], "pending")
        self.assertEqual(q["kind"], "email.send")
        self.assertEqual(q["since"], "1700000000")
        self.assertEqual(q["limit"], "10")

    def test_none_filters_not_sent(self):
        client, t = make_client((200, {"items": [], "has_more": False}))
        client.list_actions()
        q = t.calls[0]["query"]
        self.assertNotIn("status", q)
        self.assertNotIn("kind", q)
        self.assertNotIn("since", q)

    def test_returns_paged_result(self):
        response = {
            "items": [ACTION_PENDING],
            "has_more": True,
            "next_cursor": "cursor123",
        }
        client, _ = make_client((200, response))
        page = client.list_actions()
        self.assertEqual(len(page["items"]), 1)
        self.assertTrue(page["has_more"])
        self.assertEqual(page["next_cursor"], "cursor123")

    def test_items_have_is_untrusted_field(self):
        response = {"items": [ACTION_PENDING], "has_more": False}
        client, _ = make_client((200, response))
        page = client.list_actions()
        self.assertIn("is_untrusted", page["items"][0])

    def test_cursor_forwarded_on_next_page(self):
        client, t = make_client(
            (200, {"items": [ACTION_PENDING], "has_more": True, "next_cursor": "c1"}),
            (200, {"items": [], "has_more": False}),
        )
        client.list_actions()
        client.list_actions(cursor="c1")
        self.assertEqual(t.calls[1]["query"]["cursor"], "c1")

    def test_iter_actions_auto_pages(self):
        client, t = make_client(
            (200, {"items": [ACTION_PENDING, {**ACTION_PENDING, "id": "act_2"}], "has_more": True, "next_cursor": "c1"}),
            (200, {"items": [{**ACTION_PENDING, "id": "act_3"}], "has_more": False}),
        )
        items = list(client.iter_actions())
        self.assertEqual(len(items), 3)
        self.assertEqual(t.call_count, 2)
        # Second call should pass cursor
        self.assertEqual(t.calls[1]["query"]["cursor"], "c1")


# ---------------------------------------------------------------------------
# decide
# ---------------------------------------------------------------------------

class TestDecide(unittest.TestCase):

    DECISION_RESULT = {
        "id": "act_abc",
        "status": "approved",
        "verdict": "approve",
        "decided_at": 1700001000,
        "final_preview": {"format": "plain", "body": "Hello Alice"},
        "diff": None,
    }

    def test_sends_correct_method_and_path(self):
        client, t = make_client((200, self.DECISION_RESULT))
        client.decide("act_abc", "approve")
        self.assertEqual(t.calls[0]["method"], "POST")
        self.assertEqual(t.calls[0]["path"], "/v1/actions/act_abc/decision")

    def test_verdict_maps_to_decision_field(self):
        client, t = make_client((200, self.DECISION_RESULT))
        client.decide("act_abc", "approve")
        self.assertEqual(t.calls[0]["body"]["decision"], "approve")

    def test_reject_verdict(self):
        result = {**self.DECISION_RESULT, "status": "rejected", "verdict": "reject"}
        client, t = make_client((200, result))
        client.decide("act_abc", "reject")
        self.assertEqual(t.calls[0]["body"]["decision"], "reject")

    def test_edited_and_channel_forwarded(self):
        client, t = make_client((200, self.DECISION_RESULT))
        client.decide("act_abc", "approve", edited={"preview.body": "revised"}, channel="api-test")
        body = t.calls[0]["body"]
        self.assertEqual(body["edited"], {"preview.body": "revised"})
        self.assertEqual(body["channel"], "api-test")

    def test_raises_conflict_on_409(self):
        client, _ = make_client((409, {"error": "Conflict", "message": "Already decided", "current_status": "approved"}))
        with self.assertRaises(ImpriConflict) as ctx:
            client.decide("act_abc", "approve")
        self.assertEqual(ctx.exception.current_status, "approved")

    def test_raises_not_found_on_404(self):
        client, _ = make_client((404, {"error": "Not Found"}))
        with self.assertRaises(ImpriNotFound):
            client.decide("act_missing", "approve")


# ---------------------------------------------------------------------------
# report_result
# ---------------------------------------------------------------------------

class TestReportResult(unittest.TestCase):

    def test_sends_correct_method_and_path(self):
        client, t = make_client((200, RESULT_ACK))
        client.report_result("act_abc", "executed")
        self.assertEqual(t.calls[0]["method"], "POST")
        self.assertEqual(t.calls[0]["path"], "/v1/actions/act_abc/result")

    def test_status_and_detail_in_body(self):
        client, t = make_client((200, RESULT_ACK))
        client.report_result("act_abc", "execute_failed", detail="Connection refused")
        body = t.calls[0]["body"]
        self.assertEqual(body["status"], "execute_failed")
        self.assertEqual(body["detail"], "Connection refused")

    def test_detail_omitted_when_none(self):
        client, t = make_client((200, RESULT_ACK))
        client.report_result("act_abc", "executed")
        self.assertNotIn("detail", t.calls[0]["body"])

    def test_raises_conflict_when_not_approved(self):
        client, _ = make_client((409, {"error": "Conflict", "message": "Action is in state pending", "current_status": "pending"}))
        with self.assertRaises(ImpriConflict):
            client.report_result("act_abc", "executed")

    def test_returns_result_ack(self):
        client, _ = make_client((200, RESULT_ACK))
        ack = client.report_result("act_abc", "executed")
        self.assertEqual(ack["id"], "act_abc")
        self.assertEqual(ack["status"], "executed")
        self.assertEqual(ack["updated_at"], 1700002000)


# ---------------------------------------------------------------------------
# await_decision
# ---------------------------------------------------------------------------

class TestAwaitDecision(unittest.TestCase):

    def test_returns_immediately_on_already_approved(self):
        client, t = make_client((200, ACTION_APPROVED))
        result = client.await_decision("act_abc", poll_interval_s=0)
        self.assertEqual(result["status"], "approved")
        self.assertEqual(t.call_count, 1)

    def test_polls_until_approved(self):
        """First two polls return pending, third returns approved."""
        client, t = make_client(
            (200, ACTION_PENDING),
            (200, ACTION_PENDING),
            (200, ACTION_APPROVED),
        )
        with patch("time.sleep"):
            result = client.await_decision("act_abc", poll_interval_s=0.001)
        self.assertEqual(result["status"], "approved")
        self.assertEqual(t.call_count, 3)

    def test_raises_rejected_on_reject(self):
        client, _ = make_client((200, ACTION_REJECTED))
        with self.assertRaises(ImpriRejected) as ctx:
            client.await_decision("act_abc", poll_interval_s=0)
        self.assertEqual(ctx.exception.action_id, "act_abc")
        self.assertEqual(ctx.exception.decision["verdict"], "reject")

    def test_raises_expired_on_expired_status(self):
        client, _ = make_client((200, ACTION_EXPIRED))
        with self.assertRaises(ImpriExpired):
            client.await_decision("act_abc", poll_interval_s=0)

    def test_raises_timeout_when_still_pending(self):
        """Timeout elapses while action is still pending — raises ImpriTimeout.

        Mock monotonic: first call (deadline) returns 0; second call (remaining
        check after first poll) returns 1, which exceeds the deadline of 0.001.
        """
        client, _ = make_client(
            (200, ACTION_PENDING),
        )
        with patch("time.sleep"), patch("time.monotonic", side_effect=[0, 1]):
            with self.assertRaises(ImpriTimeout) as ctx:
                client.await_decision("act_abc", timeout_s=0.001, poll_interval_s=0.001)
        self.assertEqual(ctx.exception.action_id, "act_abc")

    def test_raises_not_found_on_404(self):
        client, _ = make_client((404, {"error": "Not Found"}))
        with self.assertRaises(ImpriNotFound):
            client.await_decision("act_missing", poll_interval_s=0)

    def test_approved_action_decision_present(self):
        client, _ = make_client((200, ACTION_APPROVED))
        action = client.await_decision("act_abc", poll_interval_s=0)
        self.assertIsNotNone(action.get("decision"))
        self.assertEqual(action["decision"]["final_preview"]["body"], "Hello Alice (edited)")
