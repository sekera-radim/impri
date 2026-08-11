# REST API vs MCP for Human-in-the-Loop Approval

Choosing between Impri's REST API and its MCP server comes down to where your agent runs — a Python worker calls REST directly, a Claude Code or Claude Desktop agent gets the same three-call flow for free through MCP tools.

---

## The same three calls, two transports

Whether you gate an action over REST or MCP, the underlying operation is identical: push an action, wait for a decision, execute only if approved. What changes is who writes the polling loop.

- **REST**: your code makes the HTTP calls, your code polls, your code branches on the result.
- **MCP**: the agent calls a tool, the tool blocks until a decision exists, the agent receives the result and continues.

Neither path skips the gate. Both hit the same `https://api.impri.dev` backend and the same inbox. The difference is ergonomics, not security.

---

## Scenario: an agent that merges pull requests

Say you have a coding agent that opens PRs and, when CI is green, wants to merge them. Merging is exactly the kind of side effect you don't want an agent doing unsupervised — a bad merge to `main` is not easily undone by a retry.

### Option A — a Python worker calling REST directly

This fits a standalone agent process, e.g. a cron job or a CI bot, that isn't running inside an MCP-capable client.

```python
import os
import time
import requests

API = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

def request_merge_approval(pr_number: str, pr_title: str, diff_summary: str) -> dict:
    resp = requests.post(f"{API}/v1/actions", headers=HEADERS, json={
        "kind": "github.pr_merge",
        "title": f"Merge PR #{pr_number}: {pr_title}",
        "preview": {"format": "markdown", "body": diff_summary},
        "target_url": f"https://github.com/acme/app/pull/{pr_number}",
        "expires_in": 21600,  # 6h — a stale merge approval isn't worth acting on
        "idempotent": False,
        "undo": f"git revert the merge commit for PR #{pr_number}",
    })
    action = resp.json()

    while True:
        result = requests.get(f"{API}/v1/actions/{action['id']}", headers=HEADERS).json()
        if result["status"] != "pending":
            return result
        time.sleep(10)

result = request_merge_approval("482", "Add retry backoff to webhook sender", "Adds exponential backoff...")
if result["status"] == "approved":
    merge_pr(482)  # your GitHub API call, using result["decision"]["final_preview"]
    requests.post(f"{API}/v1/actions/{result['id']}/result", headers=HEADERS,
                   json={"status": "executed"})
```

You own the retry loop, the timeout handling, and the HTTP error handling. That's more code, but it also means no dependency beyond `requests` and it runs anywhere Python runs.

### Option B — MCP inside Claude Code

If the same merge-deciding agent is a Claude Code session or subagent, wire up the MCP server once and the polling loop disappears from your code entirely — it lives inside the tool implementation:

```json
{
  "mcpServers": {
    "impri": {
      "command": "npx",
      "args": ["@impri/mcp"],
      "env": { "IMPRI_API_KEY": "im_your_key_here" }
    }
  }
}
```

The agent's flow becomes three tool calls with no HTTP client code in your prompt or scaffolding:

```
impri_push_action(kind="github.pr_merge", title="Merge PR #482: Add retry backoff",
                   preview={format:"markdown", body:"..."}, expires_in=21600)
  → { action_id: "act_482", status: "pending" }

impri_await_decision(action_id="act_482", timeout_s=21600)
  → { status: "approved", preview: {...} }

impri_report_result(action_id="act_482", status="executed")
```

---

## When to pick which

| Your setup | Use |
|---|---|
| Standalone script, cron job, backend worker | REST — no MCP runtime needed |
| Claude Code, Claude Desktop, or another MCP client | MCP — the client already speaks the protocol |
| You need custom retry/backoff logic around polling | REST — full control over the loop |
| You want the agent to reason about the wait naturally in its own tool-call loop | MCP — `impri_await_decision` blocks like any other tool call |
| Non-Node/Python runtime (Go, Rust, PHP) | REST — MCP server ships as an npx package, REST works from anywhere with HTTP |

Both share the same rate limit (60 requests/min per key to `POST /v1/actions`) and the same expiry rules — nothing about the transport changes what counts as a valid decision.

---

## The part that doesn't change either way

Regardless of transport, the gate only holds if the wrapped action truly has no other path to execution. An agent that can call the GitHub merge API directly, with its own token, can route around Impri entirely — REST or MCP. The chokepoint has to be the code path, not the request format. See [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) for the full reasoning on that boundary, and the [MCP integration guide](mcp.md) for server setup details beyond this example.

If you're building specifically on the Claude Agent SDK, [the dedicated guide](claude-agent-sdk.md) covers wrapping tool executors so the approved decision is the only path to the side effect, not just an extra step the model could skip.

Next: [quickstart](quickstart.md) to get an API key and try either path in under five minutes.
