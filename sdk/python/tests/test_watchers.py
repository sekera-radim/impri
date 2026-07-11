"""Unit tests for watcher and key/project ImpriClient methods."""
from __future__ import annotations

import unittest

from impri import ImpriClient, ImpriNotFound, ImpriQuotaExceeded
from .mock_transport import MockTransport

API_KEY = "im_testkey123"


def make_client(*responses):
    transport = MockTransport(list(responses))
    return ImpriClient(api_key=API_KEY, _transport=transport), transport


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

WATCHER = {
    "id": "wat_1",
    "name": "AI launches",
    "kind": "rss",
    "config": {"url": "https://openai.com/news/rss.xml"},
    "keywords": [{"pattern": "gpt-", "points": 2}],
    "keywords_none": ["funding"],
    "min_score": 1,
    "schedule": {"every": "8h"},
    "status": "active",
    "fail_count": 0,
    "first_run_done": False,
    "next_run_at": 1700000000,
    "created_at": 1700000000,
    "updated_at": 1700000000,
}

API_KEY_CREATED = {
    "id": "key_1",
    "name": "My key",
    "key": "im_supersecret",
    "prefix": "im_supersecret_1",
    "scopes": ["actions"],
    "project_id": "proj_1",
    "created_at": 1700000000,
    "note": "Store this key securely — it will not be shown again.",
}

PROJECT = {
    "id": "proj_1",
    "name": "My project",
    "timezone": "Europe/Prague",
    "webhook_secret": "whsec_abc",
    "created_at": 1700000000,
}


# ---------------------------------------------------------------------------
# Watchers
# ---------------------------------------------------------------------------

class TestCreateWatcher(unittest.TestCase):

    def test_sends_correct_method_and_path(self):
        client, t = make_client((201, WATCHER))
        client.create_watcher(
            name="AI launches",
            kind="rss",
            config={"url": "https://openai.com/news/rss.xml"},
            schedule={"every": "8h"},
            keywords=[{"pattern": "gpt-", "points": 2}],
            keywords_none=["funding"],
            min_score=1,
        )
        self.assertEqual(t.calls[0]["method"], "POST")
        self.assertEqual(t.calls[0]["path"], "/v1/watchers")

    def test_body_fields(self):
        client, t = make_client((201, WATCHER))
        client.create_watcher(
            name="AI launches",
            kind="rss",
            config={"url": "https://openai.com/news/rss.xml"},
            schedule={"every": "8h"},
        )
        body = t.calls[0]["body"]
        self.assertEqual(body["name"], "AI launches")
        self.assertEqual(body["kind"], "rss")
        self.assertEqual(body["config"]["url"], "https://openai.com/news/rss.xml")
        self.assertEqual(body["schedule"]["every"], "8h")

    def test_raises_quota_exceeded_on_402(self):
        client, _ = make_client((402, {"error": "Payment Required", "message": "Watcher limit", "limit": 3, "tier": "free"}))
        with self.assertRaises(ImpriQuotaExceeded) as ctx:
            client.create_watcher(
                name="X",
                kind="rss",
                config={"url": "https://example.com/rss"},
                schedule={"every": "1h"},
            )
        self.assertEqual(ctx.exception.limit, 3)
        self.assertEqual(ctx.exception.tier, "free")


class TestListWatchers(unittest.TestCase):

    def test_sends_get_to_watchers(self):
        client, t = make_client((200, {"items": [], "has_more": False}))
        client.list_watchers()
        self.assertEqual(t.calls[0]["method"], "GET")
        self.assertEqual(t.calls[0]["path"], "/v1/watchers")

    def test_status_and_kind_filter_passed(self):
        client, t = make_client((200, {"items": [], "has_more": False}))
        client.list_watchers(status="active", kind="rss")
        q = t.calls[0]["query"]
        self.assertEqual(q["status"], "active")
        self.assertEqual(q["kind"], "rss")

    def test_iter_watchers_auto_pages(self):
        client, t = make_client(
            (200, {"items": [WATCHER], "has_more": True, "next_cursor": "c1"}),
            (200, {"items": [{**WATCHER, "id": "wat_2"}], "has_more": False}),
        )
        items = list(client.iter_watchers())
        self.assertEqual(len(items), 2)
        self.assertEqual(t.call_count, 2)


class TestGetWatcher(unittest.TestCase):

    def test_sends_correct_path(self):
        client, t = make_client((200, {**WATCHER, "item_count": 42}))
        client.get_watcher("wat_1")
        self.assertEqual(t.calls[0]["path"], "/v1/watchers/wat_1")

    def test_returns_watcher_with_item_count(self):
        client, _ = make_client((200, {**WATCHER, "item_count": 42}))
        w = client.get_watcher("wat_1")
        self.assertEqual(w["item_count"], 42)

    def test_raises_not_found(self):
        client, _ = make_client((404, {"error": "Not Found"}))
        with self.assertRaises(ImpriNotFound):
            client.get_watcher("wat_missing")


class TestUpdateWatcher(unittest.TestCase):

    def test_sends_patch_with_partial_body(self):
        client, t = make_client((200, WATCHER))
        client.update_watcher("wat_1", status="paused")
        self.assertEqual(t.calls[0]["method"], "PATCH")
        self.assertEqual(t.calls[0]["path"], "/v1/watchers/wat_1")
        self.assertEqual(t.calls[0]["body"]["status"], "paused")
        # Only the supplied field should be present
        self.assertNotIn("name", t.calls[0]["body"])

    def test_only_supplied_fields_sent(self):
        client, t = make_client((200, WATCHER))
        client.update_watcher("wat_1", name="New name", min_score=3)
        body = t.calls[0]["body"]
        self.assertEqual(body["name"], "New name")
        self.assertEqual(body["min_score"], 3)
        self.assertNotIn("status", body)
        self.assertNotIn("config", body)


class TestDeleteWatcher(unittest.TestCase):

    def test_sends_delete(self):
        client, t = make_client((204, None))
        client.delete_watcher("wat_1")
        self.assertEqual(t.calls[0]["method"], "DELETE")
        self.assertEqual(t.calls[0]["path"], "/v1/watchers/wat_1")

    def test_returns_none(self):
        client, _ = make_client((204, None))
        result = client.delete_watcher("wat_1")
        self.assertIsNone(result)


# ---------------------------------------------------------------------------
# Keys
# ---------------------------------------------------------------------------

class TestCreateKey(unittest.TestCase):

    def test_sends_post_to_keys(self):
        client, t = make_client((201, API_KEY_CREATED))
        client.create_key("My key", ["actions"])
        self.assertEqual(t.calls[0]["method"], "POST")
        self.assertEqual(t.calls[0]["path"], "/v1/keys")

    def test_body_contains_name_and_scopes(self):
        client, t = make_client((201, API_KEY_CREATED))
        client.create_key("My key", ["actions", "watch"])
        body = t.calls[0]["body"]
        self.assertEqual(body["name"], "My key")
        self.assertEqual(body["scopes"], ["actions", "watch"])

    def test_returns_key_with_raw_value(self):
        client, _ = make_client((201, API_KEY_CREATED))
        created = client.create_key("My key", ["actions"])
        self.assertEqual(created["key"], "im_supersecret")


class TestListKeys(unittest.TestCase):

    KEY_ITEM = {
        "id": "key_1",
        "project_id": "proj_1",
        "prefix": "im_supersecret_1",
        "name": "My key",
        "scopes": ["actions"],
        "created_at": 1700000000,
        "last_used_at": None,
        "revoked": False,
    }

    def test_returns_list_of_keys(self):
        client, _ = make_client((200, {"items": [self.KEY_ITEM]}))
        keys = client.list_keys()
        self.assertEqual(len(keys), 1)
        self.assertEqual(keys[0]["id"], "key_1")

    def test_sends_get_to_keys(self):
        client, t = make_client((200, {"items": []}))
        client.list_keys()
        self.assertEqual(t.calls[0]["method"], "GET")
        self.assertEqual(t.calls[0]["path"], "/v1/keys")


class TestRevokeKey(unittest.TestCase):

    def test_sends_delete(self):
        client, t = make_client((204, None))
        client.revoke_key("key_1")
        self.assertEqual(t.calls[0]["method"], "DELETE")
        self.assertEqual(t.calls[0]["path"], "/v1/keys/key_1")

    def test_returns_none(self):
        client, _ = make_client((204, None))
        self.assertIsNone(client.revoke_key("key_1"))

    def test_raises_not_found_on_404(self):
        client, _ = make_client((404, {"error": "Not Found"}))
        with self.assertRaises(ImpriNotFound):
            client.revoke_key("key_missing")


# ---------------------------------------------------------------------------
# Project
# ---------------------------------------------------------------------------

class TestGetProject(unittest.TestCase):

    def test_sends_get_to_project(self):
        client, t = make_client((200, PROJECT))
        client.get_project()
        self.assertEqual(t.calls[0]["method"], "GET")
        self.assertEqual(t.calls[0]["path"], "/v1/project")

    def test_returns_project_with_webhook_secret(self):
        client, _ = make_client((200, PROJECT))
        proj = client.get_project()
        self.assertEqual(proj["webhook_secret"], "whsec_abc")


class TestUpdateProject(unittest.TestCase):

    def test_sends_patch(self):
        client, t = make_client((200, PROJECT))
        client.update_project(name="Renamed", timezone="UTC")
        self.assertEqual(t.calls[0]["method"], "PATCH")
        self.assertEqual(t.calls[0]["path"], "/v1/project")
        body = t.calls[0]["body"]
        self.assertEqual(body["name"], "Renamed")
        self.assertEqual(body["timezone"], "UTC")

    def test_only_supplied_fields_sent(self):
        client, t = make_client((200, PROJECT))
        client.update_project(name="Only name")
        body = t.calls[0]["body"]
        self.assertIn("name", body)
        self.assertNotIn("timezone", body)


class TestRotateWebhookSecret(unittest.TestCase):

    def test_sends_post(self):
        client, t = make_client((200, {"webhook_secret": "new_sec", "note": "..."}))
        client.rotate_webhook_secret()
        self.assertEqual(t.calls[0]["method"], "POST")
        self.assertEqual(t.calls[0]["path"], "/v1/project/rotate-webhook-secret")


class TestExportProject(unittest.TestCase):

    def test_sends_get(self):
        client, t = make_client((200, {"exported_at": 1, "project": {}, "actions": [], "decisions": [], "watchers": [], "audit_log": []}))
        client.export_project()
        self.assertEqual(t.calls[0]["method"], "GET")
        self.assertEqual(t.calls[0]["path"], "/v1/project/export")


class TestEraseProjectData(unittest.TestCase):

    def test_sends_delete(self):
        client, t = make_client((200, {"erased": True, "actions": 5, "watchers": 2}))
        client.erase_project_data()
        self.assertEqual(t.calls[0]["method"], "DELETE")
        self.assertEqual(t.calls[0]["path"], "/v1/project/data")

    def test_returns_erased_counts(self):
        client, _ = make_client((200, {"erased": True, "actions": 5, "watchers": 2}))
        result = client.erase_project_data()
        self.assertTrue(result["erased"])
        self.assertEqual(result["actions"], 5)
