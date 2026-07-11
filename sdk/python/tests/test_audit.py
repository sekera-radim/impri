"""Unit tests for audit-log ImpriClient methods.

Tests cover list_audit(), iter_audit(), and export_audit().
All HTTP calls go through MockTransport — no real network required.
"""
from __future__ import annotations

import unittest

from impri import (
    ImpriClient,
    AuditEvent,
    AuditPage,
    ImpriRateLimited,
    ImpriUnauthorized,
)
from .mock_transport import MockTransport

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

API_KEY = "im_testkey_audit"

AUDIT_EVENT_1: dict = {
    "id": 1001,
    "event": "action.approved",
    "action_id": "act_abc",
    "actor": "key_admin",
    "channel": "web",
    "data": {"rule_id": "rul_x"},
    "created_at": 1720001000,
}

AUDIT_EVENT_2: dict = {
    "id": 1002,
    "event": "rule.created",
    "action_id": None,
    "actor": "key_admin",
    "channel": None,
    "data": None,
    "created_at": 1720002000,
}

AUDIT_PAGE_SINGLE = {
    "items": [AUDIT_EVENT_1],
    "has_more": False,
    "next_cursor": None,
}

AUDIT_PAGE_FIRST = {
    "items": [AUDIT_EVENT_1],
    "has_more": True,
    "next_cursor": "cursor_abc",
}

AUDIT_PAGE_SECOND = {
    "items": [AUDIT_EVENT_2],
    "has_more": False,
    "next_cursor": None,
}


def make_client(*responses):
    transport = MockTransport(list(responses))
    return ImpriClient(api_key=API_KEY, _transport=transport), transport


# ---------------------------------------------------------------------------
# list_audit
# ---------------------------------------------------------------------------

class TestListAudit(unittest.TestCase):

    def test_sends_get_to_audit_path(self):
        client, t = make_client((200, AUDIT_PAGE_SINGLE))
        client.list_audit()
        self.assertEqual(t.calls[0]["method"], "GET")
        self.assertEqual(t.calls[0]["path"], "/v1/audit")

    def test_sends_bearer_auth(self):
        client, t = make_client((200, AUDIT_PAGE_SINGLE))
        client.list_audit()
        self.assertEqual(t.calls[0]["headers"]["Authorization"], f"Bearer {API_KEY}")

    def test_type_filter_forwarded(self):
        client, t = make_client((200, AUDIT_PAGE_SINGLE))
        client.list_audit(type="action.")
        self.assertEqual(t.calls[0]["query"]["type"], "action.")

    def test_actor_filter_forwarded(self):
        client, t = make_client((200, AUDIT_PAGE_SINGLE))
        client.list_audit(actor="key_admin")
        self.assertEqual(t.calls[0]["query"]["actor"], "key_admin")

    def test_entity_id_filter_forwarded(self):
        client, t = make_client((200, AUDIT_PAGE_SINGLE))
        client.list_audit(entity_id="act_abc")
        self.assertEqual(t.calls[0]["query"]["entity_id"], "act_abc")

    def test_since_and_until_forwarded(self):
        client, t = make_client((200, AUDIT_PAGE_SINGLE))
        client.list_audit(since=1720000000, until=1720009999)
        q = t.calls[0]["query"]
        self.assertEqual(q["since"], "1720000000")
        self.assertEqual(q["until"], "1720009999")

    def test_limit_forwarded(self):
        client, t = make_client((200, AUDIT_PAGE_SINGLE))
        client.list_audit(limit=10)
        self.assertEqual(t.calls[0]["query"]["limit"], "10")

    def test_cursor_forwarded(self):
        client, t = make_client((200, AUDIT_PAGE_SINGLE))
        client.list_audit(cursor="cursor_abc")
        self.assertEqual(t.calls[0]["query"]["cursor"], "cursor_abc")

    def test_none_params_not_sent(self):
        client, t = make_client((200, AUDIT_PAGE_SINGLE))
        client.list_audit()
        q = t.calls[0]["query"]
        self.assertNotIn("type", q)
        self.assertNotIn("actor", q)
        self.assertNotIn("entity_id", q)
        self.assertNotIn("since", q)
        self.assertNotIn("until", q)
        self.assertNotIn("cursor", q)

    def test_returns_audit_page(self):
        client, _ = make_client((200, AUDIT_PAGE_SINGLE))
        page = client.list_audit()
        self.assertFalse(page["has_more"])
        self.assertEqual(len(page["items"]), 1)
        self.assertEqual(page["items"][0]["event"], "action.approved")

    def test_items_have_expected_fields(self):
        client, _ = make_client((200, AUDIT_PAGE_SINGLE))
        page = client.list_audit()
        item = page["items"][0]
        self.assertEqual(item["id"], 1001)
        self.assertEqual(item["event"], "action.approved")
        self.assertEqual(item["action_id"], "act_abc")
        self.assertEqual(item["actor"], "key_admin")
        self.assertEqual(item["channel"], "web")
        self.assertEqual(item["data"], {"rule_id": "rul_x"})
        self.assertEqual(item["created_at"], 1720001000)

    def test_next_cursor_present_when_has_more(self):
        client, _ = make_client((200, AUDIT_PAGE_FIRST))
        page = client.list_audit()
        self.assertTrue(page["has_more"])
        self.assertEqual(page["next_cursor"], "cursor_abc")

    def test_multiple_filter_params_combined(self):
        client, t = make_client((200, AUDIT_PAGE_SINGLE))
        client.list_audit(type="key.", actor="key_admin", since=1720000000, limit=25)
        q = t.calls[0]["query"]
        self.assertEqual(q["type"], "key.")
        self.assertEqual(q["actor"], "key_admin")
        self.assertEqual(q["since"], "1720000000")
        self.assertEqual(q["limit"], "25")

    def test_raises_unauthorized_on_403(self):
        client, _ = make_client((403, {"error": "Forbidden", "message": "Scope 'admin' required"}))
        with self.assertRaises(ImpriUnauthorized):
            client.list_audit()

    def test_raises_rate_limited_on_429(self):
        client, _ = make_client((429, {"error": "Too Many Requests", "retry_after": 5}))
        with self.assertRaises(ImpriRateLimited):
            client.list_audit()

    def test_empty_page_no_items(self):
        client, _ = make_client((200, {"items": [], "has_more": False}))
        page = client.list_audit()
        self.assertEqual(page["items"], [])
        self.assertFalse(page["has_more"])


# ---------------------------------------------------------------------------
# iter_audit
# ---------------------------------------------------------------------------

class TestIterAudit(unittest.TestCase):

    def test_yields_items_from_single_page(self):
        client, t = make_client((200, AUDIT_PAGE_SINGLE))
        items = list(client.iter_audit())
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["event"], "action.approved")
        self.assertEqual(t.call_count, 1)

    def test_auto_pages_two_pages(self):
        client, t = make_client(
            (200, AUDIT_PAGE_FIRST),
            (200, AUDIT_PAGE_SECOND),
        )
        items = list(client.iter_audit())
        self.assertEqual(len(items), 2)
        self.assertEqual(t.call_count, 2)
        self.assertEqual(items[0]["event"], "action.approved")
        self.assertEqual(items[1]["event"], "rule.created")

    def test_second_call_passes_cursor(self):
        client, t = make_client(
            (200, AUDIT_PAGE_FIRST),
            (200, AUDIT_PAGE_SECOND),
        )
        list(client.iter_audit())
        self.assertEqual(t.calls[1]["query"]["cursor"], "cursor_abc")

    def test_type_filter_forwarded_to_all_pages(self):
        client, t = make_client(
            (200, AUDIT_PAGE_FIRST),
            (200, AUDIT_PAGE_SECOND),
        )
        list(client.iter_audit(type="action."))
        self.assertEqual(t.calls[0]["query"]["type"], "action.")
        self.assertEqual(t.calls[1]["query"]["type"], "action.")

    def test_yields_nothing_on_empty_page(self):
        client, _ = make_client((200, {"items": [], "has_more": False}))
        items = list(client.iter_audit())
        self.assertEqual(items, [])

    def test_limit_forwarded_each_page(self):
        client, t = make_client((200, AUDIT_PAGE_SINGLE))
        list(client.iter_audit(limit=100))
        self.assertEqual(t.calls[0]["query"]["limit"], "100")

    def test_since_and_until_forwarded(self):
        client, t = make_client((200, AUDIT_PAGE_SINGLE))
        list(client.iter_audit(since=1720000000, until=1720009999))
        q = t.calls[0]["query"]
        self.assertEqual(q["since"], "1720000000")
        self.assertEqual(q["until"], "1720009999")


# ---------------------------------------------------------------------------
# export_audit
# ---------------------------------------------------------------------------

NDJSON_EXPORT = (
    b'{"id":1001,"event":"action.approved","action_id":"act_abc",'
    b'"actor":"key_admin","channel":"web","data":{"rule_id":"rul_x"},'
    b'"created_at":1720001000}\n'
    b'{"id":1002,"event":"rule.created","action_id":null,'
    b'"actor":"key_admin","channel":null,"data":null,'
    b'"created_at":1720002000}\n'
)

CSV_EXPORT = (
    b"id,event,action_id,actor,channel,data,created_at\r\n"
    b'1001,action.approved,act_abc,key_admin,web,"{""rule_id"":""rul_x""}",1720001000\r\n'
    b"1002,rule.created,,key_admin,,,1720002000\r\n"
)


class TestExportAudit(unittest.TestCase):

    def test_sends_get_to_audit_export_path(self):
        client, t = make_client((200, NDJSON_EXPORT))
        client.export_audit()
        self.assertEqual(t.calls[0]["method"], "GET")
        self.assertEqual(t.calls[0]["path"], "/v1/audit/export")

    def test_sends_bearer_auth(self):
        client, t = make_client((200, NDJSON_EXPORT))
        client.export_audit()
        self.assertEqual(t.calls[0]["headers"]["Authorization"], f"Bearer {API_KEY}")

    def test_default_format_is_json(self):
        client, t = make_client((200, NDJSON_EXPORT))
        client.export_audit()
        self.assertEqual(t.calls[0]["query"]["format"], "json")

    def test_csv_format_forwarded(self):
        client, t = make_client((200, CSV_EXPORT))
        client.export_audit(format="csv")
        self.assertEqual(t.calls[0]["query"]["format"], "csv")

    def test_type_filter_forwarded(self):
        client, t = make_client((200, NDJSON_EXPORT))
        client.export_audit(type="action.")
        self.assertEqual(t.calls[0]["query"]["type"], "action.")

    def test_actor_filter_forwarded(self):
        client, t = make_client((200, NDJSON_EXPORT))
        client.export_audit(actor="key_admin")
        self.assertEqual(t.calls[0]["query"]["actor"], "key_admin")

    def test_entity_id_filter_forwarded(self):
        client, t = make_client((200, NDJSON_EXPORT))
        client.export_audit(entity_id="act_abc")
        self.assertEqual(t.calls[0]["query"]["entity_id"], "act_abc")

    def test_since_and_until_forwarded(self):
        client, t = make_client((200, NDJSON_EXPORT))
        client.export_audit(since=1720000000, until=1720009999)
        q = t.calls[0]["query"]
        self.assertEqual(q["since"], "1720000000")
        self.assertEqual(q["until"], "1720009999")

    def test_none_filters_not_sent(self):
        client, t = make_client((200, NDJSON_EXPORT))
        client.export_audit()
        q = t.calls[0]["query"]
        self.assertNotIn("type", q)
        self.assertNotIn("actor", q)
        self.assertNotIn("entity_id", q)
        self.assertNotIn("since", q)
        self.assertNotIn("until", q)

    def test_returns_raw_bytes_ndjson(self):
        client, _ = make_client((200, NDJSON_EXPORT))
        result = client.export_audit()
        self.assertIsInstance(result, bytes)
        self.assertEqual(result, NDJSON_EXPORT)

    def test_returns_raw_bytes_csv(self):
        client, _ = make_client((200, CSV_EXPORT))
        result = client.export_audit(format="csv")
        self.assertIsInstance(result, bytes)
        self.assertEqual(result, CSV_EXPORT)

    def test_ndjson_can_be_decoded_as_utf8(self):
        client, _ = make_client((200, NDJSON_EXPORT))
        result = client.export_audit()
        lines = result.decode("utf-8").strip().split("\n")
        self.assertEqual(len(lines), 2)
        import json
        first = json.loads(lines[0])
        self.assertEqual(first["event"], "action.approved")

    def test_raises_unauthorized_on_403(self):
        client, _ = make_client((403, {"error": "Forbidden", "message": "Scope 'admin' required"}))
        with self.assertRaises(ImpriUnauthorized):
            client.export_audit()

    def test_raises_rate_limited_on_429(self):
        client, _ = make_client((429, {"error": "Too Many Requests", "retry_after": 12}))
        with self.assertRaises(ImpriRateLimited):
            client.export_audit()

    def test_all_filter_params_combined(self):
        client, t = make_client((200, NDJSON_EXPORT))
        client.export_audit(
            type="action.",
            actor="key_admin",
            entity_id="act_abc",
            since=1720000000,
            until=1720009999,
            format="csv",
        )
        q = t.calls[0]["query"]
        self.assertEqual(q["type"], "action.")
        self.assertEqual(q["actor"], "key_admin")
        self.assertEqual(q["entity_id"], "act_abc")
        self.assertEqual(q["since"], "1720000000")
        self.assertEqual(q["until"], "1720009999")
        self.assertEqual(q["format"], "csv")
