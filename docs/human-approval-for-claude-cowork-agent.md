# Human Approval for Claude Cowork Browser Agent Actions

A browser agent that can click, type, and submit forms on your behalf is only as safe as the last click it takes without asking — this pattern makes the submit click wait for you.

---

## The specific risk of a browser agent

A computer-use or browser agent isn't limited to a fixed API surface the way a scripted integration is. It's operating a real browser session — your session, often with your cookies and your logins — and deciding moment to moment which button to press. That's exactly what makes it useful for things like filling out a vendor form, submitting an expense report, or posting a listing on a marketplace. It's also why the *last* action in that sequence — the actual submit — is the one worth gating. Everything before it (navigating, reading a page, filling fields) is reversible by just not submitting. The submit is not.

The fix isn't to slow the agent down everywhere. It's to make the agent stop specifically before the irreversible click and wait for a person to look at what it's about to do.

## Gating the submit step, not the whole session

If your agent is built on the Claude Agent SDK with computer-use tools, the cleanest place to insert the check is a thin wrapper around whichever tool actually performs the submit — not a change to the browsing loop itself. The agent still navigates and fills forms freely; only the final action routes through Impri first.

```python
import os
import time
import requests

IMPRI_KEY = os.environ["IMPRI_API_KEY"]
BASE = "https://api.impri.dev"


def gated_submit(form_summary: str, screenshot_url: str, page_url: str) -> bool:
    """Call this instead of the raw 'click submit' tool. Returns True
    only if a human approved; the caller must not click submit otherwise."""
    resp = requests.post(
        f"{BASE}/v1/actions",
        headers={"Authorization": f"Bearer {IMPRI_KEY}"},
        json={
            "kind": "browser.form_submit",
            "title": f"Submit form: {page_url}",
            "preview": {"format": "markdown", "body": form_summary},
            "target_url": page_url,
            "expires_in": 900,
            "undo": "No automatic undo — review the page before approving.",
        },
    )
    action_id = resp.json()["id"]

    while True:
        poll = requests.get(
            f"{BASE}/v1/actions/{action_id}",
            headers={"Authorization": f"Bearer {IMPRI_KEY}"},
        ).json()
        if poll["status"] != "pending":
            return poll["status"] == "approved"
        time.sleep(4)
```

The agent's tool definition for "submit form" calls `gated_submit()` first and only proceeds to the actual click if it returns `True`. Because the browser session's cookies and the ability to click "Submit" live inside the same tool the agent already uses, wrapping that one tool is enough — there's no separate direct path for the agent to press the button without going through the wrapper, unlike an API-based agent that might also hold a raw credential.

`form_summary` matters more here than in most Impri integrations: since the reviewer is approving a *click*, not reading structured JSON, give them the filled-in field values (a markdown table of field → value works well) rather than a vague "submit the form" title. A screenshot URL in `target_url` lets the reviewer glance at the actual rendered page before deciding.

## Why `undo` is close to useless here and `expires_in` isn't

Most Impri actions benefit from a real `undo` description. A browser form submission usually doesn't have one — once submitted, there's no API call that reverses it, so be honest in the field rather than inventing a rollback that doesn't exist. Where this scenario *does* benefit from Impri's mechanics is `expires_in`: browser state goes stale fast. A logged-in session, a shopping cart, a multi-step wizard — all of that can time out or reset server-side within minutes. Set `expires_in` short (the example above uses 900 seconds) so a reviewer who's slow to respond gets an `expired` action rather than an approval that then fails against a browser session that's moved on.

## What this doesn't cover

Impri gates the one tool call you wrapped. It has no visibility into the rest of the browser session — if the agent has another tool that can navigate directly to a different "submit" endpoint, or if it's running with a service account that bypasses the UI entirely, this pattern doesn't see it. Treat this as gating a specific chokepoint you've identified, not a sandbox around the whole agent.

See [the MCP integration guide](mcp.md) if your agent already talks to tools over MCP — `impri_push_action` and `impri_await_decision` replace the raw `requests` calls above. For the SDK-specific plumbing around Claude Agent SDK tool wrapping, see [human approval with the Claude Agent SDK](human-approval-claude-agent-sdk.md), and for getting a key set up first, [quickstart](quickstart.md).
