"""Default HTTP transport using stdlib urllib (zero external dependencies).

The transport is intentionally thin: (method, url, headers, body_bytes) →
(status_code: int, body_bytes: bytes). Error mapping lives in the client so
a test transport can return arbitrary (status, body) tuples without needing to
raise urllib exceptions.

A custom transport can be injected into ImpriClient via the _transport parameter:

    def my_transport(method, url, headers, body=None):
        # ... make the request ...
        return status_code, response_bytes

    client = ImpriClient(api_key="im_...", _transport=my_transport)
"""
from __future__ import annotations

import urllib.error
import urllib.request
from typing import Callable, Optional, Tuple

from ._exceptions import ImpriApiError

# Type alias used in ImpriClient signature.
Transport = Callable[
    [str, str, dict, Optional[bytes]],
    Tuple[int, bytes],
]


def urllib_transport(
    method: str,
    url: str,
    headers: dict,
    body: Optional[bytes] = None,
) -> Tuple[int, bytes]:
    """Make an HTTP request and return (status_code, body_bytes).

    On HTTP error responses (4xx/5xx), urllib raises HTTPError. We catch it and
    return (status, body) so the client can map it to typed exceptions uniformly.

    On connection errors (URLError, not HTTPError), raises ImpriApiError directly
    since there is no status code to map.
    """
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        return exc.code, raw
    except urllib.error.URLError as exc:
        raise ImpriApiError(0, f"Connection error: {exc.reason}") from exc
