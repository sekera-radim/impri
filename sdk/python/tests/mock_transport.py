"""Shared mock transport for unit tests.

MockTransport replaces the urllib HTTP layer with a queue of pre-programmed
responses. Every call is recorded in .calls so tests can assert on request
shape (method, URL path, headers, JSON body).
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple


class MockTransport:
    """Injectable transport for ImpriClient.

    Usage::

        transport = MockTransport([
            (201, {"id": "act_1", "status": "pending", ...}),
            (200, {"id": "act_1", "status": "approved", "decision": {...}}),
        ])
        client = ImpriClient(api_key="im_test", _transport=transport)
        created = client.create_action(...)   # consumes response 0
        action  = client.get_action(...)      # consumes response 1

        # Assert on captured calls
        assert transport.calls[0]["method"] == "POST"
        assert transport.calls[0]["path"] == "/v1/actions"
        body = transport.calls[0]["body"]
        assert body["kind"] == "email.send"
    """

    def __init__(self, responses: List[Tuple[int, Any]]) -> None:
        # Each element: (status_code, body_dict | None)
        self._responses = list(responses)
        self._idx = 0
        self.calls: List[Dict[str, Any]] = []

    def __call__(
        self,
        method: str,
        url: str,
        headers: Dict[str, str],
        body: Optional[bytes] = None,
    ) -> Tuple[int, bytes]:
        # Parse the URL into path for easier assertion
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(url)
        query = parse_qs(parsed.query, keep_blank_values=True)
        # Flatten single-element lists from parse_qs
        flat_query = {k: v[0] if len(v) == 1 else v for k, v in query.items()}

        body_dict: Any = None
        if body:
            try:
                body_dict = json.loads(body.decode())
            except Exception:
                body_dict = body

        self.calls.append({
            "method": method,
            "url": url,
            "path": parsed.path,
            "query": flat_query,
            "headers": headers,
            "body": body_dict,
        })

        if self._idx >= len(self._responses):
            raise AssertionError(
                f"MockTransport: no more responses (call #{self._idx + 1}, "
                f"method={method!r}, url={url!r})"
            )

        status, resp_body = self._responses[self._idx]
        self._idx += 1

        if resp_body is None or status == 204:
            return status, b""
        # Allow tests to inject pre-serialized bytes (e.g. ndjson / CSV for export).
        if isinstance(resp_body, bytes):
            return status, resp_body
        return status, json.dumps(resp_body).encode()

    @property
    def call_count(self) -> int:
        return len(self.calls)

    def assert_exhausted(self) -> None:
        """Assert that all programmed responses were consumed."""
        assert self._idx == len(self._responses), (
            f"MockTransport: {len(self._responses) - self._idx} response(s) not consumed"
        )
