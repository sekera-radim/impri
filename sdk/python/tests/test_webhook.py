"""Unit tests for the standalone verify_webhook() signature helper."""
from __future__ import annotations

import hmac
import hashlib
import time
import unittest

from impri import verify_webhook, ImpriWebhookSignatureError


def _make_signature(secret: str, timestamp: str, nonce: str, raw_body: bytes) -> str:
    """Helper that mirrors the server-side signing algorithm."""
    message = f"{timestamp}.{nonce}.".encode() + raw_body
    digest = hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


class TestVerifyWebhook(unittest.TestCase):

    SECRET = "whsec_test_secret"
    # Use a fresh timestamp so the replay-protection window check always passes
    # in tests that verify the success path.
    TIMESTAMP = str(int(time.time()))
    NONCE = "abc123nonce"
    BODY = b'{"id":"act_1","status":"approved"}'

    def _valid_sig(self, body=None):
        # Use `is None` check so that an empty-bytes body (b"") is not
        # accidentally treated as falsy and replaced by self.BODY.
        actual_body = body if body is not None else self.BODY
        return _make_signature(self.SECRET, self.TIMESTAMP, self.NONCE, actual_body)

    def test_passes_with_valid_signature(self):
        sig = self._valid_sig()
        # Should not raise
        verify_webhook(self.BODY, self.SECRET, self.TIMESTAMP, self.NONCE, sig)

    def test_raises_on_wrong_secret(self):
        sig = _make_signature("wrong_secret", self.TIMESTAMP, self.NONCE, self.BODY)
        with self.assertRaises(ImpriWebhookSignatureError):
            verify_webhook(self.BODY, self.SECRET, self.TIMESTAMP, self.NONCE, sig)

    def test_raises_on_tampered_body(self):
        sig = self._valid_sig()
        tampered = b'{"id":"act_1","status":"hacked"}'
        with self.assertRaises(ImpriWebhookSignatureError):
            verify_webhook(tampered, self.SECRET, self.TIMESTAMP, self.NONCE, sig)

    def test_raises_on_wrong_timestamp(self):
        sig = _make_signature(self.SECRET, "0000000000", self.NONCE, self.BODY)
        with self.assertRaises(ImpriWebhookSignatureError):
            verify_webhook(self.BODY, self.SECRET, self.TIMESTAMP, self.NONCE, sig)

    def test_raises_on_wrong_nonce(self):
        sig = _make_signature(self.SECRET, self.TIMESTAMP, "wrongnonce", self.BODY)
        with self.assertRaises(ImpriWebhookSignatureError):
            verify_webhook(self.BODY, self.SECRET, self.TIMESTAMP, self.NONCE, sig)

    def test_raises_on_missing_sha256_prefix(self):
        raw_digest = hmac.new(
            self.SECRET.encode(),
            f"{self.TIMESTAMP}.{self.NONCE}.".encode() + self.BODY,
            hashlib.sha256,
        ).hexdigest()
        # Missing "sha256=" prefix — compare_digest will mismatch
        with self.assertRaises(ImpriWebhookSignatureError):
            verify_webhook(self.BODY, self.SECRET, self.TIMESTAMP, self.NONCE, raw_digest)

    def test_empty_body_accepted(self):
        """An empty body is valid — e.g. a webhook ping."""
        sig = self._valid_sig(body=b"")
        verify_webhook(b"", self.SECRET, self.TIMESTAMP, self.NONCE, sig)

    def test_binary_body_accepted(self):
        """Raw body may contain non-UTF8 bytes from gzip or base64 encoding."""
        body = bytes(range(256))
        sig = _make_signature(self.SECRET, self.TIMESTAMP, self.NONCE, body)
        verify_webhook(body, self.SECRET, self.TIMESTAMP, self.NONCE, sig)
