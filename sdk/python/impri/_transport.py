"""Default HTTP transport using stdlib urllib (zero external dependencies).

The transport is intentionally thin: it takes (method, url, headers, body_bytes)
and returns (status_code: int, response_bytes: bytes). Error mapping lives in
the client layer so the mock transport in tests can return arbitrary status codes
without needing to raise urllib exceptions.
"""
from __future__ import annotations

import urllib.error
import urllib.request
from typing import Tuple


def urllib_transport(
    method: str,
    url: str,
    headers: dict,
    body: bytes | None = None,
) -> Tuple[int, bytes]:
    """Make an HTTP request and return (status_code, body_bytes).

    On HTTP error responses (4xx/5xx), urllib raises HTTPError. We catch it
    and return the status + body so the client layer can map it to typed
    exceptions uniformly.
    """
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        return exc.code, raw
