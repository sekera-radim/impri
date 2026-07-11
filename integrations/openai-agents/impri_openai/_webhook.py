"""Standalone webhook signature verification.

No client instance required — this is a pure function that uses only stdlib.
"""
from __future__ import annotations

import hashlib
import hmac
import time

from ._errors import ImpriWebhookSignatureError

_EXPECTED_PREFIX = "sha256="


def verify_webhook(
    raw_body: bytes | str,
    secret: str,
    timestamp: str,
    nonce: str,
    signature: str,
    tolerance_sec: int = 300,
) -> None:
    """Verify the HMAC-SHA256 signature of an Impri webhook delivery.

    Algorithm::

        sha256=HMAC-SHA256(secret, f'{timestamp}.{nonce}.{raw_body}')

    Pass the exact raw bytes of the request body (NOT parsed JSON) and the
    three ``X-Impri-*`` headers::

        verify_webhook(
            raw_body=request.body,
            secret=project.webhook_secret,
            timestamp=request.headers['X-Impri-Timestamp'],
            nonce=request.headers['X-Impri-Nonce'],
            signature=request.headers['X-Impri-Signature'],
        )

    Raises:
        ImpriWebhookSignatureError: on HMAC mismatch, missing secret,
            unrecognized signature format, or stale timestamp (replay protection).
    """
    if not secret:
        raise ImpriWebhookSignatureError(
            "webhook_secret must not be empty. "
            "Fetch it with client.get_project() → project['webhook_secret']."
        )
    if not signature.startswith(_EXPECTED_PREFIX):
        raise ImpriWebhookSignatureError(
            f"Unrecognized signature format: {signature!r}. Expected 'sha256=...'."
        )

    # Replay-protection: reject deliveries outside the tolerance window.
    try:
        ts = int(timestamp)
    except (ValueError, TypeError):
        raise ImpriWebhookSignatureError(
            "X-Impri-Timestamp is missing or not a valid integer."
        )
    if abs(time.time() - ts) > tolerance_sec:
        raise ImpriWebhookSignatureError(
            f"Webhook timestamp is outside the {tolerance_sec}s tolerance window "
            "(replay protection). Ensure your server clock is synced."
        )

    if isinstance(raw_body, str):
        raw_body = raw_body.encode()

    payload = f"{timestamp}.{nonce}.".encode() + raw_body
    mac = hmac.new(secret.encode(), payload, hashlib.sha256)
    expected = f"{_EXPECTED_PREFIX}{mac.hexdigest()}"

    if not hmac.compare_digest(expected, signature):
        raise ImpriWebhookSignatureError(
            "Webhook signature mismatch. "
            "Check that you are using the correct webhook_secret and "
            "that the raw request body has not been modified."
        )
