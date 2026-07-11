"""Unit tests for ergonomic helpers: requires_approval decorator and approval_gate context manager."""
from __future__ import annotations

import unittest
import warnings
from unittest.mock import patch

from impri import ImpriClient, ImpriRejected, ImpriTimeout, ImpriExpired
from .mock_transport import MockTransport

API_KEY = "im_testkey123"


def make_client(*responses):
    transport = MockTransport(list(responses))
    return ImpriClient(api_key=API_KEY, _transport=transport), transport


ACTION_CREATED = {
    "id": "act_abc",
    "status": "pending",
    "inbox_url": "http://localhost:8484/inbox/act_abc",
    "expires_at": 9999999999,
    "created_at": 1700000000,
}

ACTION_PENDING_BASE = {
    "id": "act_abc",
    "kind": "email.send",
    "title": "Send email",
    "status": "pending",
    "preview": {"format": "plain", "body": "Hello"},
    "editable": ["preview.body"],
    "created_at": 1700000000,
    "updated_at": 1700000000,
}

ACTION_APPROVED = {
    **ACTION_PENDING_BASE,
    "status": "approved",
    "decision": {
        "verdict": "approve",
        "decided_at": 1700001000,
        "final_preview": {"format": "plain", "body": "Hello (reviewed)"},
    },
}

ACTION_APPROVED_UNEDITED = {
    **ACTION_PENDING_BASE,
    "status": "approved",
    "decision": {
        "verdict": "approve",
        "decided_at": 1700001000,
        "final_preview": {"format": "plain", "body": "Hello"},
    },
}

ACTION_REJECTED = {
    **ACTION_PENDING_BASE,
    "status": "rejected",
    "decision": {
        "verdict": "reject",
        "decided_at": 1700001000,
    },
}

RESULT_ACK = {"id": "act_abc", "status": "executed", "updated_at": 1700002000}
RESULT_FAILED_ACK = {"id": "act_abc", "status": "execute_failed", "updated_at": 1700002000}


# ---------------------------------------------------------------------------
# requires_approval decorator
# ---------------------------------------------------------------------------

class TestRequiresApproval(unittest.TestCase):

    def test_calls_wrapped_function_on_approve(self):
        client, _ = make_client(
            (201, ACTION_CREATED),
            (200, ACTION_APPROVED),
        )
        results = []

        @client.requires_approval(
            kind="email.send",
            title="Send email",
            preview={"format": "plain", "body": "Hello"},
        )
        def send_email(to: str) -> str:
            results.append(to)
            return "sent"

        ret = send_email("alice@example.com")
        self.assertEqual(ret, "sent")
        self.assertIn("alice@example.com", results)

    def test_raises_rejected_without_calling_function(self):
        client, _ = make_client(
            (201, ACTION_CREATED),
            (200, ACTION_REJECTED),
        )
        calls = []

        @client.requires_approval(kind="k", title="t", preview={"format": "plain", "body": ""})
        def my_func():
            calls.append(True)

        with self.assertRaises(ImpriRejected):
            my_func()
        self.assertEqual(len(calls), 0)

    def test_injects_edited_body_when_body_param_present(self):
        client, _ = make_client(
            (201, ACTION_CREATED),
            (200, ACTION_APPROVED),  # final_preview.body = "Hello (reviewed)"
        )
        received_body = []

        @client.requires_approval(
            kind="email.send",
            title="Send email",
            editable=["preview.body"],
        )
        def send_email(to: str, body: str) -> None:
            received_body.append(body)

        send_email("alice@example.com", body="Hello")
        self.assertEqual(received_body[0], "Hello (reviewed)")

    def test_injects_decision_kwarg_when_no_body_param(self):
        client, _ = make_client(
            (201, ACTION_CREATED),
            (200, ACTION_APPROVED),
        )
        received_decision = []

        @client.requires_approval(
            kind="email.send",
            title="Send email",
            preview={"format": "plain", "body": "Hi"},
            editable=["preview.body"],
        )
        def process(task_id: str, _decision=None) -> None:
            received_decision.append(_decision)

        process("t1")
        self.assertIsNotNone(received_decision[0])
        self.assertEqual(received_decision[0]["verdict"], "approve")

    def test_callable_title_receives_args(self):
        client, t = make_client(
            (201, ACTION_CREATED),
            (200, ACTION_APPROVED),
        )

        @client.requires_approval(
            kind="k",
            title=lambda to, **_: f"Send to {to}",
            preview={"format": "plain", "body": ""},
        )
        def send(to: str) -> None:
            pass

        send("bob@example.com")
        # create_action call body should have the computed title
        self.assertEqual(t.calls[0]["body"]["title"], "Send to bob@example.com")

    def test_callable_preview_receives_args(self):
        client, t = make_client(
            (201, ACTION_CREATED),
            (200, ACTION_APPROVED),
        )

        @client.requires_approval(
            kind="k",
            title="T",
            preview=lambda to, msg, **_: {"format": "plain", "body": f"{to}: {msg}"},
        )
        def send(to: str, msg: str) -> None:
            pass

        send("alice@example.com", "hello world")
        self.assertEqual(t.calls[0]["body"]["preview"]["body"], "alice@example.com: hello world")

    def test_push_kwargs_forwarded_to_create_action(self):
        client, t = make_client(
            (201, ACTION_CREATED),
            (200, ACTION_APPROVED),
        )

        @client.requires_approval(
            kind="k",
            title="t",
            preview={"format": "plain", "body": ""},
            expires_in=3600,
        )
        def my_func() -> None:
            pass

        my_func()
        self.assertEqual(t.calls[0]["body"]["expires_in"], 3600)


# ---------------------------------------------------------------------------
# approval_gate context manager
# ---------------------------------------------------------------------------

class TestApprovalGate(unittest.TestCase):

    def test_yields_approved_action_on_approve(self):
        client, _ = make_client(
            (201, ACTION_CREATED),
            (200, ACTION_APPROVED),
            (200, RESULT_ACK),       # report_result("executed") called on clean exit
        )
        with client.approval_gate(
            kind="db.exec",
            title="DROP TABLE users",
            preview={"format": "plain", "body": "DROP TABLE users"},
        ) as approved:
            self.assertEqual(approved.action_id, "act_abc")
            self.assertEqual(approved.final_preview["body"], "Hello (reviewed)")
            self.assertEqual(approved.decision["verdict"], "approve")

    def test_calls_report_result_executed_on_clean_exit(self):
        client, t = make_client(
            (201, ACTION_CREATED),
            (200, ACTION_APPROVED),
            (200, RESULT_ACK),
        )
        with client.approval_gate(
            kind="k", title="t", preview={"format": "plain", "body": ""}
        ) as _:
            pass

        # Third call should be POST /v1/actions/act_abc/result
        self.assertEqual(t.calls[2]["method"], "POST")
        self.assertEqual(t.calls[2]["path"], "/v1/actions/act_abc/result")
        self.assertEqual(t.calls[2]["body"]["status"], "executed")

    def test_calls_report_result_execute_failed_on_exception(self):
        client, t = make_client(
            (201, ACTION_CREATED),
            (200, ACTION_APPROVED),
            (200, RESULT_FAILED_ACK),
        )
        with self.assertRaises(RuntimeError):
            with client.approval_gate(
                kind="k", title="t", preview={"format": "plain", "body": ""}
            ) as _:
                raise RuntimeError("downstream failed")

        self.assertEqual(t.calls[2]["body"]["status"], "execute_failed")
        self.assertIn("downstream failed", t.calls[2]["body"].get("detail", ""))

    def test_raises_rejected_before_yield(self):
        client, t = make_client(
            (201, ACTION_CREATED),
            (200, ACTION_REJECTED),
            # No report_result expected — rejected means we never yielded
        )
        with self.assertRaises(ImpriRejected):
            with client.approval_gate(
                kind="k", title="t", preview={"format": "plain", "body": ""}
            ) as _:
                pass  # Should not reach here

        # Only 2 calls: create_action + get_action (no report_result)
        self.assertEqual(t.call_count, 2)

    def test_untrusted_payload_emits_warning(self):
        client, _ = make_client(
            (201, ACTION_CREATED),
            (200, ACTION_APPROVED),
            (200, RESULT_ACK),
        )
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            with client.approval_gate(
                kind="k",
                title="t",
                preview={"format": "plain", "body": ""},
                payload={"untrusted": True, "url": "https://reddit.com/..."},
            ) as _:
                pass

        user_warnings = [x for x in w if issubclass(x.category, UserWarning)]
        self.assertTrue(
            any("untrusted" in str(x.message).lower() for x in user_warnings),
            "Expected a UserWarning mentioning untrusted payload",
        )

    def test_report_result_failure_does_not_mask_original_error(self):
        """If report_result fails, the original exception still propagates."""
        client, t = make_client(
            (201, ACTION_CREATED),
            (200, ACTION_APPROVED),
            (409, {"error": "Conflict", "message": "Not approved"}),  # report_result fails
        )
        original_error = ValueError("something broke")
        with self.assertRaises(ValueError) as ctx:
            with client.approval_gate(
                kind="k", title="t", preview={"format": "plain", "body": ""}
            ) as _:
                raise original_error

        self.assertIs(ctx.exception, original_error)


# ---------------------------------------------------------------------------
# Config errors
# ---------------------------------------------------------------------------

class TestConfigErrors(unittest.TestCase):

    def test_raises_config_error_when_no_api_key(self):
        from impri import ImpriConfigError
        import os
        env_backup = os.environ.pop("IMPRI_API_KEY", None)
        try:
            with self.assertRaises(ImpriConfigError):
                ImpriClient()
        finally:
            if env_backup is not None:
                os.environ["IMPRI_API_KEY"] = env_backup

    def test_reads_api_key_from_environment(self):
        import os
        os.environ["IMPRI_API_KEY"] = "im_from_env"
        try:
            client = ImpriClient()
            self.assertEqual(client._api_key, "im_from_env")
        finally:
            del os.environ["IMPRI_API_KEY"]

    def test_base_url_arg_takes_precedence_over_env(self):
        import os
        os.environ["IMPRI_BASE_URL"] = "https://api.impri.dev"
        try:
            client = ImpriClient(api_key="im_k", base_url="https://custom.example.com")
            self.assertEqual(client._base_url, "https://custom.example.com")
        finally:
            del os.environ["IMPRI_BASE_URL"]

    def test_trailing_slash_stripped_from_base_url(self):
        client = ImpriClient(api_key="im_k", base_url="https://api.impri.dev/")
        self.assertEqual(client._base_url, "https://api.impri.dev")

    def test_default_base_url_is_localhost(self):
        import os
        os.environ.pop("IMPRI_BASE_URL", None)
        client = ImpriClient(api_key="im_k")
        self.assertEqual(client._base_url, "http://localhost:8484")
