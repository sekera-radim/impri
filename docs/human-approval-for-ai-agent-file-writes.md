# Human Approval Before an AI Agent Writes to Your Filesystem

An autonomous coding or file-organizing agent with write access can overwrite the wrong file in one bad tool call — route every write through a human approval gate first, with the diff attached, so nothing lands unseen.

---

## Not all writes carry the same risk

| Write type | Blast radius if wrong | Gate it? |
|---|---|---|
| New file in a scratch/output directory | Low — easy to delete | Usually no |
| Edit to an existing tracked source file | Medium — overwrites working code | Yes |
| Write to a config file, `.env`, or credentials-adjacent path | High — can break auth, deploys, secrets handling | Always |
| Delete or truncate an existing file | High — often unrecoverable without VCS | Always |
| Write outside the intended project root (path traversal, wrong cwd) | High — unpredictable | Always |

A reasonable default: gate any write that isn't a brand-new file inside a directory the agent was explicitly told is disposable. Everything else goes through approval.

---

## The integration

This example is a Python agent with a `write_file` tool. Instead of writing immediately, it stages the change, computes a diff against the current file (if one exists), and pushes that diff as the approval preview.

```python
import difflib
import os
import time
import requests

IMPRI_KEY = os.environ["IMPRI_API_KEY"]
BASE = "https://api.impri.dev"

def request_write_approval(path: str, new_content: str) -> str:
    old_content = ""
    if os.path.exists(path):
        with open(path) as f:
            old_content = f.read()

    diff = "".join(difflib.unified_diff(
        old_content.splitlines(keepends=True),
        new_content.splitlines(keepends=True),
        fromfile=path, tofile=path,
    )) or "(new file, no prior content)"

    resp = requests.post(f"{BASE}/v1/actions", headers={
        "Authorization": f"Bearer {IMPRI_KEY}",
        "Content-Type": "application/json",
    }, json={
        "kind": "fs.write",
        "title": f"Write to {path}",
        "preview": {"format": "markdown", "body": f"```diff\n{diff}\n```"},
        "expires_in": 1800,
        "editable": ["preview.body"],
        "idempotent": False,
        "undo": f"Restore {path} from git or the previous version shown in this diff",
    })
    return resp.json()["id"]

def await_and_write(path: str, action_id: str) -> str:
    while True:
        resp = requests.get(f"{BASE}/v1/actions/{action_id}",
                             headers={"Authorization": f"Bearer {IMPRI_KEY}"})
        data = resp.json()
        if data["status"] == "pending":
            time.sleep(5)
            continue
        if data["status"] != "approved":
            return data["status"]  # rejected or expired — caller does not write

        final_body = data["decision"]["final_preview"]["body"]
        # final_body is the diff, possibly edited — apply it, or re-derive content
        # from the agent's own state if the human only approved without editing.
        with open(path, "w") as f:
            f.write(new_content_from(final_body))

        requests.post(f"{BASE}/v1/actions/{action_id}/result",
                       headers={"Authorization": f"Bearer {IMPRI_KEY}"},
                       json={"status": "executed", "payload": {"path": path}})
        return "executed"
```

Because `editable` includes `preview.body`, a reviewer can hand-edit the diff text in the inbox before approving — useful for trimming an over-eager rewrite down to the lines that actually need to change. If your agent can't safely reconstruct a file from an edited diff, drop `editable` for this action kind and treat the approval as yes/no only; the tradeoff is real and worth making deliberately rather than defaulting to "editable everywhere."

---

## Why `idempotent: false` and `undo` matter here specifically

File writes are usually not idempotent — writing the same content twice is harmless, but retrying after a partial failure risks writing over a write that already partially landed. Setting `"idempotent": false` puts a warning badge on the card so the reviewer knows a retry isn't automatically safe. The `undo` field matters more for filesystem actions than almost any other kind: unlike an email you can't unsend, a file write in a git-tracked repo genuinely can be undone, but only if the agent tells the reviewer how *before* they approve, not after something goes wrong.

---

## Making the gate the only path to disk

This pattern only holds if `write_file` above — not the agent's model output — is the sole function with filesystem write access in that process. If the agent is also running inside an environment where it can shell out (`os.system`, a code-execution tool, a raw MCP filesystem server with no wrapper), it can write around the gate entirely. Wrap or disable direct filesystem tools and expose only the approval-gated `write_file`; the [SDK integration patterns](integrations.md) cover this kind of tool substitution in more depth. If your agent runs on the [Claude Agent SDK](claude-agent-sdk.md), this is the same principle as restricting the `Edit`/`Write` tool to a checked wrapper rather than the raw filesystem.

---

## What Impri does not check

Impri does not know whether the new file content is syntactically valid, whether it passes your linter, or whether it will actually build. It shows the human a diff and holds a decision — nothing more. Pair this with your existing CI and pre-commit checks, which should still run on whatever the agent eventually writes; approval and correctness-checking are separate concerns that happen to share a gate here.

---

Next: the [quickstart](quickstart.md) covers getting an API key for cloud or self-hosted use, and the [Python SDK](sdk-python.md) wraps the raw `requests` calls above into a small client if you'd rather not hand-roll the polling loop.
