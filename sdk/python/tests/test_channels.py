"""Unit tests for notification channel ImpriClient methods."""
from __future__ import annotations

import unittest

from impri import ImpriClient, ImpriNotFound, ImpriUnauthorized, ImpriValidationError
from .mock_transport import MockTransport

API_KEY = "im_testkey123"


def make_client(*responses):
    transport = MockTransport(list(responses))
    return ImpriClient(api_key=API_KEY, _transport=transport), transport


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

SLACK_CHANNEL = {
    "id": "ch_slack1",
    "project_id": "proj_1",
    "name": "Slack ops",
    "type": "slack",
    "enabled": True,
    "config": {"url": "****cdef"},   # masked last-4
    "digest_window_sec": 60,
    "last_fired_at": None,
    "fail_count": 0,
    "last_error": None,
    "created_at": 1700000000,
    "updated_at": 1700000000,
}

TELEGRAM_CHANNEL = {
    "id": "ch_tg1",
    "project_id": "proj_1",
    "name": "Telegram alerts",
    "type": "telegram",
    "enabled": True,
    "config": {"bot_token": "****:abc", "chat_id": "-1001234567890"},
    "digest_window_sec": 120,
    "last_fired_at": 1700001000,
    "fail_count": 0,
    "last_error": None,
    "created_at": 1700000000,
    "updated_at": 1700000000,
}

WEBHOOK_CHANNEL = {
    "id": "ch_wh1",
    "project_id": "proj_1",
    "name": "Generic webhook",
    "type": "webhook",
    "enabled": True,
    "config": {"url": "****cdef", "hmac_secret": "****7890"},
    "digest_window_sec": 60,
    "last_fired_at": None,
    "fail_count": 0,
    "last_error": None,
    "created_at": 1700000000,
    "updated_at": 1700000000,
}

NTFY_CHANNEL = {
    "id": "ch_ntfy1",
    "project_id": "proj_1",
    "name": "ntfy self-hosted",
    "type": "ntfy",
    "enabled": True,
    "config": {"url": "****8765", "topic": "my-alerts"},
    "digest_window_sec": 60,
    "last_fired_at": None,
    "fail_count": 0,
    "last_error": None,
    "created_at": 1700000000,
    "updated_at": 1700000000,
}

EMAIL_CHANNEL = {
    "id": "ch_email1",
    "project_id": "proj_1",
    "name": "Email ops",
    "type": "email",
    "enabled": True,
    "config": {"address": "ops@example.com"},
    "digest_window_sec": 300,
    "last_fired_at": None,
    "fail_count": 0,
    "last_error": None,
    "created_at": 1700000000,
    "updated_at": 1700000000,
}


# ---------------------------------------------------------------------------
# list_notification_channels
# ---------------------------------------------------------------------------

class TestListNotificationChannels(unittest.TestCase):

    def test_sends_get_to_correct_path(self):
        client, t = make_client((200, {"channels": [SLACK_CHANNEL]}))
        client.list_notification_channels()
        self.assertEqual(t.calls[0]["method"], "GET")
        self.assertEqual(t.calls[0]["path"], "/v1/notification-channels")

    def test_returns_list_of_channels(self):
        client, _ = make_client((200, {"channels": [SLACK_CHANNEL, TELEGRAM_CHANNEL]}))
        channels = client.list_notification_channels()
        self.assertEqual(len(channels), 2)
        self.assertEqual(channels[0]["id"], "ch_slack1")
        self.assertEqual(channels[1]["id"], "ch_tg1")

    def test_empty_list(self):
        client, _ = make_client((200, {"channels": []}))
        channels = client.list_notification_channels()
        self.assertEqual(channels, [])

    def test_bearer_header_is_sent(self):
        client, t = make_client((200, {"channels": []}))
        client.list_notification_channels()
        self.assertIn("Authorization", t.calls[0]["headers"])
        self.assertEqual(t.calls[0]["headers"]["Authorization"], f"Bearer {API_KEY}")

    def test_raises_unauthorized_on_403(self):
        client, _ = make_client((403, {"error": "Forbidden"}))
        with self.assertRaises(ImpriUnauthorized):
            client.list_notification_channels()


# ---------------------------------------------------------------------------
# create_notification_channel
# ---------------------------------------------------------------------------

class TestCreateNotificationChannel(unittest.TestCase):

    def test_sends_post_to_correct_path(self):
        client, t = make_client((201, SLACK_CHANNEL))
        client.create_notification_channel(
            "Slack ops", "slack", {"url": "https://hooks.slack.com/services/T00/B00/abcdef"}
        )
        self.assertEqual(t.calls[0]["method"], "POST")
        self.assertEqual(t.calls[0]["path"], "/v1/notification-channels")

    def test_body_contains_required_fields(self):
        client, t = make_client((201, SLACK_CHANNEL))
        client.create_notification_channel(
            "Slack ops", "slack", {"url": "https://hooks.slack.com/services/T00/B00/abcdef"}
        )
        body = t.calls[0]["body"]
        self.assertEqual(body["name"], "Slack ops")
        self.assertEqual(body["type"], "slack")
        self.assertEqual(body["config"]["url"], "https://hooks.slack.com/services/T00/B00/abcdef")

    def test_defaults_enabled_true_and_digest_60(self):
        client, t = make_client((201, SLACK_CHANNEL))
        client.create_notification_channel("S", "slack", {"url": "https://hooks.slack.com/x"})
        body = t.calls[0]["body"]
        self.assertTrue(body["enabled"])
        self.assertEqual(body["digest_window_sec"], 60)

    def test_custom_enabled_and_digest_window(self):
        client, t = make_client((201, SLACK_CHANNEL))
        client.create_notification_channel(
            "Slack ops", "slack",
            {"url": "https://hooks.slack.com/services/T00/B00/abcdef"},
            enabled=False,
            digest_window_sec=300,
        )
        body = t.calls[0]["body"]
        self.assertFalse(body["enabled"])
        self.assertEqual(body["digest_window_sec"], 300)

    def test_config_secrets_are_masked_in_response(self):
        client, _ = make_client((201, SLACK_CHANNEL))
        ch = client.create_notification_channel(
            "Slack ops", "slack", {"url": "https://hooks.slack.com/services/T00/B00/abcdef"}
        )
        # The server returns masked values; SDK passes them through as-is
        self.assertTrue(ch["config"]["url"].startswith("****"))

    def test_telegram_channel_creation(self):
        client, t = make_client((201, TELEGRAM_CHANNEL))
        client.create_notification_channel(
            "Telegram alerts", "telegram",
            {"bot_token": "123456789:AAFxxxxxxxxxxxxxxxx", "chat_id": "-1001234567890"},
        )
        body = t.calls[0]["body"]
        self.assertEqual(body["type"], "telegram")
        self.assertIn("bot_token", body["config"])
        self.assertIn("chat_id", body["config"])

    def test_email_channel_creation(self):
        client, t = make_client((201, EMAIL_CHANNEL))
        client.create_notification_channel("Email ops", "email", {"address": "ops@example.com"})
        body = t.calls[0]["body"]
        self.assertEqual(body["type"], "email")
        self.assertEqual(body["config"]["address"], "ops@example.com")

    def test_webhook_channel_with_hmac_secret(self):
        client, t = make_client((201, WEBHOOK_CHANNEL))
        client.create_notification_channel(
            "Generic webhook", "webhook",
            {"url": "https://myapp.example.com/impri-hook", "hmac_secret": "my-secret-1234567890"},
        )
        body = t.calls[0]["body"]
        self.assertEqual(body["type"], "webhook")
        self.assertIn("hmac_secret", body["config"])

    def test_ntfy_channel_creation(self):
        client, t = make_client((201, NTFY_CHANNEL))
        client.create_notification_channel(
            "ntfy self-hosted", "ntfy",
            {"url": "https://ntfy.sh", "topic": "my-alerts"},
        )
        body = t.calls[0]["body"]
        self.assertEqual(body["type"], "ntfy")
        self.assertEqual(body["config"]["topic"], "my-alerts")

    def test_raises_validation_error_on_400(self):
        client, _ = make_client((400, {"error": "Validation error", "message": "config.url is required"}))
        with self.assertRaises(ImpriValidationError):
            client.create_notification_channel("Bad", "slack", {})


# ---------------------------------------------------------------------------
# get_notification_channel
# ---------------------------------------------------------------------------

class TestGetNotificationChannel(unittest.TestCase):

    def test_sends_get_to_channel_path(self):
        client, t = make_client((200, SLACK_CHANNEL))
        client.get_notification_channel("ch_slack1")
        self.assertEqual(t.calls[0]["method"], "GET")
        self.assertEqual(t.calls[0]["path"], "/v1/notification-channels/ch_slack1")

    def test_returns_channel(self):
        client, _ = make_client((200, SLACK_CHANNEL))
        ch = client.get_notification_channel("ch_slack1")
        self.assertEqual(ch["id"], "ch_slack1")
        self.assertEqual(ch["type"], "slack")

    def test_config_url_is_masked(self):
        client, _ = make_client((200, SLACK_CHANNEL))
        ch = client.get_notification_channel("ch_slack1")
        self.assertTrue(ch["config"]["url"].startswith("****"))

    def test_telegram_chat_id_not_masked(self):
        client, _ = make_client((200, TELEGRAM_CHANNEL))
        ch = client.get_notification_channel("ch_tg1")
        # chat_id is not a secret — returned as-is
        self.assertEqual(ch["config"]["chat_id"], "-1001234567890")

    def test_email_address_not_masked(self):
        client, _ = make_client((200, EMAIL_CHANNEL))
        ch = client.get_notification_channel("ch_email1")
        # email address is not a secret
        self.assertEqual(ch["config"]["address"], "ops@example.com")

    def test_raises_not_found_on_404(self):
        client, _ = make_client((404, {"error": "Not Found"}))
        with self.assertRaises(ImpriNotFound):
            client.get_notification_channel("ch_missing")


# ---------------------------------------------------------------------------
# update_notification_channel
# ---------------------------------------------------------------------------

class TestUpdateNotificationChannel(unittest.TestCase):

    def test_sends_patch_to_correct_path(self):
        client, t = make_client((200, SLACK_CHANNEL))
        client.update_notification_channel("ch_slack1", name="Renamed")
        self.assertEqual(t.calls[0]["method"], "PATCH")
        self.assertEqual(t.calls[0]["path"], "/v1/notification-channels/ch_slack1")

    def test_only_supplied_fields_sent(self):
        client, t = make_client((200, SLACK_CHANNEL))
        client.update_notification_channel("ch_slack1", name="New name")
        body = t.calls[0]["body"]
        self.assertIn("name", body)
        self.assertNotIn("config", body)
        self.assertNotIn("enabled", body)
        self.assertNotIn("digest_window_sec", body)

    def test_can_disable_channel(self):
        updated = {**SLACK_CHANNEL, "enabled": False}
        client, t = make_client((200, updated))
        ch = client.update_notification_channel("ch_slack1", enabled=False)
        self.assertFalse(t.calls[0]["body"]["enabled"])
        self.assertFalse(ch["enabled"])

    def test_can_update_digest_window(self):
        updated = {**SLACK_CHANNEL, "digest_window_sec": 300}
        client, t = make_client((200, updated))
        client.update_notification_channel("ch_slack1", digest_window_sec=300)
        self.assertEqual(t.calls[0]["body"]["digest_window_sec"], 300)

    def test_can_update_config(self):
        client, t = make_client((200, SLACK_CHANNEL))
        client.update_notification_channel(
            "ch_slack1",
            config={"url": "https://hooks.slack.com/services/T00/B00/newurl"},
        )
        self.assertIn("config", t.calls[0]["body"])
        self.assertIn("url", t.calls[0]["body"]["config"])

    def test_can_update_multiple_fields(self):
        client, t = make_client((200, SLACK_CHANNEL))
        client.update_notification_channel(
            "ch_slack1",
            name="Updated",
            enabled=True,
            digest_window_sec=120,
        )
        body = t.calls[0]["body"]
        self.assertEqual(body["name"], "Updated")
        self.assertTrue(body["enabled"])
        self.assertEqual(body["digest_window_sec"], 120)

    def test_raises_not_found_on_404(self):
        client, _ = make_client((404, {"error": "Not Found"}))
        with self.assertRaises(ImpriNotFound):
            client.update_notification_channel("ch_missing", name="X")

    def test_no_fields_sends_empty_body(self):
        client, t = make_client((200, SLACK_CHANNEL))
        client.update_notification_channel("ch_slack1")
        self.assertEqual(t.calls[0]["body"], {})


# ---------------------------------------------------------------------------
# delete_notification_channel
# ---------------------------------------------------------------------------

class TestDeleteNotificationChannel(unittest.TestCase):

    def test_sends_delete_to_correct_path(self):
        client, t = make_client((204, None))
        client.delete_notification_channel("ch_slack1")
        self.assertEqual(t.calls[0]["method"], "DELETE")
        self.assertEqual(t.calls[0]["path"], "/v1/notification-channels/ch_slack1")

    def test_returns_none(self):
        client, _ = make_client((204, None))
        result = client.delete_notification_channel("ch_slack1")
        self.assertIsNone(result)

    def test_raises_not_found_on_404(self):
        client, _ = make_client((404, {"error": "Not Found"}))
        with self.assertRaises(ImpriNotFound):
            client.delete_notification_channel("ch_missing")


# ---------------------------------------------------------------------------
# test_notification_channel
# ---------------------------------------------------------------------------

class TestTestNotificationChannel(unittest.TestCase):

    def test_sends_post_to_test_path(self):
        client, t = make_client((200, {"ok": True}))
        client.test_notification_channel("ch_slack1")
        self.assertEqual(t.calls[0]["method"], "POST")
        self.assertEqual(t.calls[0]["path"], "/v1/notification-channels/ch_slack1/test")

    def test_returns_ok_true_on_success(self):
        client, _ = make_client((200, {"ok": True}))
        result = client.test_notification_channel("ch_slack1")
        self.assertTrue(result["ok"])

    def test_returns_ok_false_with_error_on_delivery_failure(self):
        client, _ = make_client((200, {"ok": False, "error": "connection refused"}))
        result = client.test_notification_channel("ch_slack1")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "connection refused")

    def test_error_field_does_not_contain_raw_secret(self):
        # Server guarantees sanitized error; SDK passes through as-is
        # This test confirms the SDK does not add the secret itself
        client, _ = make_client((200, {"ok": False, "error": "delivery failed"}))
        result = client.test_notification_channel("ch_tg1")
        self.assertNotIn("bot_token", result.get("error", ""))

    def test_raises_not_found_on_404(self):
        client, _ = make_client((404, {"error": "Not Found"}))
        with self.assertRaises(ImpriNotFound):
            client.test_notification_channel("ch_missing")

    def test_raises_unauthorized_on_403(self):
        client, _ = make_client((403, {"error": "Forbidden"}))
        with self.assertRaises(ImpriUnauthorized):
            client.test_notification_channel("ch_slack1")


if __name__ == "__main__":
    unittest.main()
