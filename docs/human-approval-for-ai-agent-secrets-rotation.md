# Human Approval for AI Agent Secrets and API Key Rotation

An agent that rotates its own API keys can lock you out of production — human approval for AI agent secrets rotation turns that risk into a reviewable step first.

---

## Why key rotation is a bad place for full autonomy

Rotation agents exist for a good reason: expiring keys, leaked credentials, and compliance windows don't wait for someone to notice. But the failure mode is asymmetric. If the agent rotates the wrong key, revokes the old one too early, or rotates a key that three other services still depend on, you don't find out from a log line — you find out from a pager alert. The action is also close to irreversible in practice: once the old secret is revoked, anything still using it breaks immediately, and there is no "undo rotation" button in most secrets managers.

That combination — high blast radius, hard to reverse, and triggered by an agent's own judgment about what's "expiring soon" — is exactly the case for a human checkpoint before the revoke step, not after.

## Gating the rotation with Impri

The agent still does all the work: it detects the expiring key, generates the replacement, and prepares the revoke call. What it doesn't do is call revoke before a human signs off. In Python, that's a `requests` call before the mutating step:

```python
import os
import time
import requests

IMPRI_BASE = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

def request_rotation_approval(service: str, key_id: str, expires_at: str) -> dict:
    resp = requests.post(
        f"{IMPRI_BASE}/v1/actions",
        headers=HEADERS,
        json={
            "kind": "secret.rotate_api_key",
            "title": f"Rotate {service} API key ({key_id}) — expires {expires_at}",
            "preview": {
                "format": "markdown",
                "body": (
                    f"**Service:** {service}\n**Key ID:** `{key_id}`\n"
                    f"**Expires:** {expires_at}\n\n"
                    "New key has been generated and stored in the vault under "
                    f"`{service}/pending`. Approving this will revoke the old key."
                ),
            },
            "idempotent": False,
            "undo": "Old key remains valid for 24h in the vault's revoked-but-cached list; restore it manually if rotation breaks a dependency.",
            "expires_in": 3600,
        },
    )
    return resp.json()

def poll_and_execute(action_id: str, service: str, key_id: str):
    while True:
        result = requests.get(f"{IMPRI_BASE}/v1/actions/{action_id}", headers=HEADERS).json()
        if result["status"] != "pending":
            break
        time.sleep(10)

    if result["status"] == "approved":
        revoke_old_key(service, key_id)  # your vault/IAM call
        requests.post(
            f"{IMPRI_BASE}/v1/actions/{action_id}/result",
            headers=HEADERS,
            json={"status": "executed", "payload": {"revoked_key_id": key_id}},
        )
    else:
        print(f"Rotation for {key_id} not executed: {result['status']}")
```

A one-hour `expires_in` is deliberate here — a key rotation request that's still unreviewed after an hour should probably page someone directly rather than sit in a queue.

## What the reviewer sees

The inbox card carries the service name, key ID, and expiry in the title so a reviewer can triage from a phone notification without opening a dashboard. Because `idempotent` is `false`, Impri shows a "retrying may duplicate this action" warning — worth keeping even though rotation isn't exactly duplicable, since it flags that re-approving after a failed execution needs a fresh look, not a blind retry. The `undo` field turns into a visible note on the card, so the person approving knows the old key isn't gone the instant they click approve.

## Handling failure and rollback

If `revoke_old_key` throws after approval, report `execute_failed` rather than swallowing the exception — see the [result reporting section](how-to-add-human-approval-to-an-ai-agent.md) for the exact call. A silent failure here is worse than the rotation never happening, because the on-call reviewer now believes the key was rotated when it wasn't.

## Where this fits next to your secrets manager

Impri doesn't store secrets, generate them, or talk to your vault — it only holds the pending decision and the audit trail of who approved what and when. The actual key generation and revocation stay in Vault, AWS Secrets Manager, or whatever you already run. For the underlying request/poll/execute pattern in more detail, start with the [quickstart](quickstart.md), and if your rotation agent lives inside Claude Code or another MCP client, see the [MCP integration](mcp.md) to skip writing the HTTP calls by hand.
