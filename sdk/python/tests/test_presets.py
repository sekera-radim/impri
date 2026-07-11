"""Unit tests for list_watcher_presets() and create_watcher_from_preset()."""
from __future__ import annotations

import unittest

from impri import ImpriClient, ImpriNotFound, ImpriQuotaExceeded, ImpriValidationError
from .mock_transport import MockTransport

API_KEY = "im_testkey123"


def make_client(*responses):
    transport = MockTransport(list(responses))
    return ImpriClient(api_key=API_KEY, _transport=transport), transport


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

PRESET_HN_FRONT_PAGE = {
    "id": "hn-front-page",
    "title": "Hacker News Front Page",
    "description": "New posts as they appear on the HN front page",
    "category": "Community",
    "kind": "rss",
    "params": [],
    "defaultScheduleEvery": "30m",
    "buildNotes": "config.url = \"https://news.ycombinator.com/rss\"",
}

PRESET_HN_KEYWORD = {
    "id": "hn-keyword",
    "title": "Hacker News – Keyword",
    "description": "HN posts mentioning a keyword",
    "category": "Community",
    "kind": "rss",
    "params": [
        {
            "name": "keyword",
            "required": True,
            "description": "Word or phrase to search for",
            "example": "rust programming",
        },
        {
            "name": "min_points",
            "required": False,
            "description": "Minimum upvote points",
            "example": "25",
        },
    ],
    "defaultScheduleEvery": "30m",
    "buildNotes": "config.url = `https://hnrss.org/newest?q=...`",
}

PRESET_GITHUB_RELEASES = {
    "id": "github-releases",
    "title": "GitHub – Repository Releases",
    "description": "New releases published to a GitHub repository",
    "category": "Developer",
    "kind": "rss",
    "params": [
        {
            "name": "owner",
            "required": True,
            "description": "GitHub username or organization",
            "example": "fastify",
        },
        {
            "name": "repo",
            "required": True,
            "description": "Repository name",
            "example": "fastify",
        },
    ],
    "defaultScheduleEvery": "1h",
    "buildNotes": "config.url = `https://github.com/${owner}/${repo}/releases.atom`",
}

PRESETS_RESPONSE = {
    "presets": [PRESET_HN_FRONT_PAGE, PRESET_HN_KEYWORD, PRESET_GITHUB_RELEASES],
}

# Minimal watcher fixture returned by the server after preset instantiation.
WATCHER = {
    "id": "wat_preset_1",
    "name": "Hacker News Front Page",
    "kind": "rss",
    "config": {"url": "https://news.ycombinator.com/rss"},
    "keywords": [],
    "keywords_none": [],
    "min_score": 0,
    "schedule": {"every": "30m"},
    "status": "active",
    "fail_count": 0,
    "first_run_done": False,
    "next_run_at": 1700000000,
    "created_at": 1700000000,
    "updated_at": 1700000000,
}


# ---------------------------------------------------------------------------
# list_watcher_presets
# ---------------------------------------------------------------------------

class TestListWatcherPresets(unittest.TestCase):

    def test_sends_get_to_correct_path(self):
        client, t = make_client((200, PRESETS_RESPONSE))
        client.list_watcher_presets()
        self.assertEqual(t.calls[0]["method"], "GET")
        self.assertEqual(t.calls[0]["path"], "/v1/watcher-presets")

    def test_sends_bearer_auth_header(self):
        client, t = make_client((200, PRESETS_RESPONSE))
        client.list_watcher_presets()
        self.assertEqual(t.calls[0]["headers"]["Authorization"], f"Bearer {API_KEY}")

    def test_sends_no_request_body(self):
        client, t = make_client((200, PRESETS_RESPONSE))
        client.list_watcher_presets()
        self.assertIsNone(t.calls[0]["body"])

    def test_returns_presets_list(self):
        client, _ = make_client((200, PRESETS_RESPONSE))
        result = client.list_watcher_presets()
        presets = result["presets"]
        self.assertEqual(len(presets), 3)

    def test_preset_fields_preserved(self):
        client, _ = make_client((200, PRESETS_RESPONSE))
        result = client.list_watcher_presets()
        first = result["presets"][0]
        self.assertEqual(first["id"], "hn-front-page")
        self.assertEqual(first["title"], "Hacker News Front Page")
        self.assertEqual(first["category"], "Community")
        self.assertEqual(first["kind"], "rss")
        self.assertEqual(first["defaultScheduleEvery"], "30m")
        self.assertEqual(first["params"], [])

    def test_preset_params_shape(self):
        client, _ = make_client((200, PRESETS_RESPONSE))
        result = client.list_watcher_presets()
        hn_keyword = result["presets"][1]
        self.assertEqual(len(hn_keyword["params"]), 2)
        required_param = hn_keyword["params"][0]
        self.assertEqual(required_param["name"], "keyword")
        self.assertTrue(required_param["required"])
        self.assertEqual(required_param["example"], "rust programming")

    def test_single_call_made(self):
        client, t = make_client((200, PRESETS_RESPONSE))
        client.list_watcher_presets()
        self.assertEqual(t.call_count, 1)


# ---------------------------------------------------------------------------
# create_watcher_from_preset — request shape
# ---------------------------------------------------------------------------

class TestCreateWatcherFromPresetRequestShape(unittest.TestCase):

    def test_sends_post_to_correct_path(self):
        client, t = make_client((201, WATCHER))
        client.create_watcher_from_preset("hn-front-page")
        self.assertEqual(t.calls[0]["method"], "POST")
        self.assertEqual(t.calls[0]["path"], "/v1/watchers/from-preset")

    def test_sends_bearer_auth_header(self):
        client, t = make_client((201, WATCHER))
        client.create_watcher_from_preset("hn-front-page")
        self.assertEqual(t.calls[0]["headers"]["Authorization"], f"Bearer {API_KEY}")

    def test_body_contains_preset_id(self):
        client, t = make_client((201, WATCHER))
        client.create_watcher_from_preset("hn-front-page")
        self.assertEqual(t.calls[0]["body"]["preset_id"], "hn-front-page")

    def test_body_contains_empty_params_when_omitted(self):
        client, t = make_client((201, WATCHER))
        client.create_watcher_from_preset("hn-front-page")
        self.assertEqual(t.calls[0]["body"]["params"], {})

    def test_body_contains_params_when_supplied(self):
        client, t = make_client((201, WATCHER))
        client.create_watcher_from_preset(
            "hn-keyword",
            params={"keyword": "rust programming", "min_points": "25"},
        )
        body = t.calls[0]["body"]
        self.assertEqual(body["preset_id"], "hn-keyword")
        self.assertEqual(body["params"]["keyword"], "rust programming")
        self.assertEqual(body["params"]["min_points"], "25")

    def test_body_contains_params_none_as_empty_dict(self):
        # params=None (default) must be serialised as {} not null
        client, t = make_client((201, WATCHER))
        client.create_watcher_from_preset("hn-front-page", params=None)
        self.assertEqual(t.calls[0]["body"]["params"], {})

    def test_name_omitted_from_body_when_not_supplied(self):
        client, t = make_client((201, WATCHER))
        client.create_watcher_from_preset("hn-front-page")
        self.assertNotIn("name", t.calls[0]["body"])

    def test_name_included_in_body_when_supplied(self):
        client, t = make_client((201, WATCHER))
        client.create_watcher_from_preset("hn-front-page", name="My HN feed")
        self.assertEqual(t.calls[0]["body"]["name"], "My HN feed")

    def test_schedule_omitted_from_body_when_not_supplied(self):
        client, t = make_client((201, WATCHER))
        client.create_watcher_from_preset("hn-front-page")
        self.assertNotIn("schedule", t.calls[0]["body"])

    def test_schedule_included_in_body_when_supplied(self):
        client, t = make_client((201, WATCHER))
        client.create_watcher_from_preset(
            "hn-front-page",
            schedule={"every": "1h", "window": "06:00-22:00"},
        )
        body = t.calls[0]["body"]
        self.assertEqual(body["schedule"]["every"], "1h")
        self.assertEqual(body["schedule"]["window"], "06:00-22:00")

    def test_extra_kwargs_forwarded_to_body(self):
        client, t = make_client((201, WATCHER))
        client.create_watcher_from_preset("hn-front-page", _extra_field="x")
        self.assertEqual(t.calls[0]["body"]["_extra_field"], "x")

    def test_github_releases_multi_param(self):
        watcher = {**WATCHER, "id": "wat_gh", "name": "GitHub – fastify/fastify Releases"}
        client, t = make_client((201, watcher))
        client.create_watcher_from_preset(
            "github-releases",
            params={"owner": "fastify", "repo": "fastify"},
            name="GitHub – fastify/fastify Releases",
        )
        body = t.calls[0]["body"]
        self.assertEqual(body["preset_id"], "github-releases")
        self.assertEqual(body["params"]["owner"], "fastify")
        self.assertEqual(body["params"]["repo"], "fastify")
        self.assertEqual(body["name"], "GitHub – fastify/fastify Releases")


# ---------------------------------------------------------------------------
# create_watcher_from_preset — response and error mapping
# ---------------------------------------------------------------------------

class TestCreateWatcherFromPresetResponse(unittest.TestCase):

    def test_returns_watcher_dict(self):
        client, _ = make_client((201, WATCHER))
        w = client.create_watcher_from_preset("hn-front-page")
        self.assertEqual(w["id"], "wat_preset_1")
        self.assertEqual(w["kind"], "rss")
        self.assertEqual(w["status"], "active")

    def test_returns_watcher_with_preset_schedule(self):
        client, _ = make_client((201, WATCHER))
        w = client.create_watcher_from_preset("hn-front-page")
        self.assertEqual(w["schedule"]["every"], "30m")

    def test_raises_not_found_on_unknown_preset(self):
        client, _ = make_client((404, {"error": "preset_not_found"}))
        with self.assertRaises(ImpriNotFound):
            client.create_watcher_from_preset("nonexistent-preset")

    def test_raises_validation_error_on_missing_required_param(self):
        client, _ = make_client(
            (400, {"error": "Bad Request", "issues": [{"message": "keyword is required"}]})
        )
        with self.assertRaises(ImpriValidationError) as ctx:
            client.create_watcher_from_preset("hn-keyword", params={})
        self.assertIn("keyword", ctx.exception.issues[0]["message"])

    def test_raises_validation_error_on_invalid_param_format(self):
        client, _ = make_client(
            (400, {"error": "Bad Request", "issues": [{"message": "Invalid channel_id format"}]})
        )
        with self.assertRaises(ImpriValidationError):
            client.create_watcher_from_preset(
                "youtube-channel",
                params={"channel_id": "invalid!"},
            )

    def test_raises_quota_exceeded_on_watcher_limit(self):
        client, _ = make_client(
            (402, {"error": "Payment Required", "message": "Watcher limit", "limit": 3, "tier": "free"})
        )
        with self.assertRaises(ImpriQuotaExceeded) as ctx:
            client.create_watcher_from_preset("hn-front-page")
        self.assertEqual(ctx.exception.limit, 3)
        self.assertEqual(ctx.exception.tier, "free")

    def test_single_call_made(self):
        client, t = make_client((201, WATCHER))
        client.create_watcher_from_preset("hn-front-page")
        self.assertEqual(t.call_count, 1)


if __name__ == "__main__":
    unittest.main()
