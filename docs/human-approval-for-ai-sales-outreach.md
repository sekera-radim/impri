# Human Approval for AI Sales Outreach Agents

Gate every AI-drafted sales email or LinkedIn DM before it reaches a prospect — this guide shows how to add human approval to outreach agents using Impri.

---

## Why outreach agents need a gate

A sales outreach agent is a category of agent with an unusual risk profile: the mistake is public, personal, and addressed to someone by name.

A miscalibrated draft can address a prospect at the wrong company, use a tone that doesn't fit the relationship, reference a detail that is factually wrong or creepy, or simply repeat a message the person already received last week. You don't know until they tell you — or don't.

The usual mitigation is a "review before sending" note in the system prompt. That is not a gate. The model has to be trusted to actually pause, and nothing prevents it from sending anyway if the prompt gets long or the context window compresses. A real gate is a data dependency: the sending code cannot run unless the approval API returns `status: "approved"`.

Impri provides that dependency. The agent pushes each drafted message, you get a card in your inbox to approve or edit, and only the approved version — including any edits you made — goes out.

---

## What the approval flow looks like

```
Agent                           Impri                          You
  │                               │                              │
  ├── POST /v1/actions ───────────▶  stores draft, notifies ────▶  inbox card
  │   kind: "email.send"          │                              │
  │   editable: ["preview.body"]  │                              ├── read, edit, approve
  │                               │◀─────────────────────────────┘
  ├── GET /v1/actions/:id ────────▶  status: "approved"
  │   (poll until decided)        │  decision.final_preview.body = your edited version
  │                               │
  ├── send_email(final_body)      │
  │                               │
  └── POST /v1/actions/:id/result (executed)
```

The agent can only reach the send call through the approval response. If you reject, the draft is discarded. If you edit and approve, the agent executes with your revised version.

---

## Python integration

This example assumes a list of prospects with pre-researched context. The agent drafts the email, pushes it for approval, and waits. Sending only happens with the approved body.

```python
import httpx
import time

IMPRI_API_KEY = "im_your_key_here"
BASE_URL = "https://api.impri.dev"

def push_outreach_for_approval(prospect: dict, draft: str) -> str:
    resp = httpx.post(
        f"{BASE_URL}/v1/actions",
        headers={"Authorization": f"Bearer {IMPRI_API_KEY}"},
        json={
            "kind": "email.send",
            "title": f"Outreach: {prospect['name']} at {prospect['company']}",
            "preview": {
                "format": "markdown",
                "body": draft,
            },
            "target_url": prospect.get("linkedin_url"),
            "expires_in": 43200,   # 12 h — stale outreach is not worth sending
            "editable": ["preview.body"],
        },
    )
    resp.raise_for_status()
    return resp.json()["id"]

def await_decision(action_id: str) -> dict:
    while True:
        result = httpx.get(
            f"{BASE_URL}/v1/actions/{action_id}",
            headers={"Authorization": f"Bearer {IMPRI_API_KEY}"},
        ).json()
        if result["status"] != "pending":
            return result
        time.sleep(15)

def report_result(action_id: str, status: str) -> None:
    httpx.post(
        f"{BASE_URL}/v1/actions/{action_id}/result",
        headers={"Authorization": f"Bearer {IMPRI_API_KEY}"},
        json={"status": status},
    )

# --- agent loop ---
prospect = {
    "name": "Jordan Lee",
    "company": "Vertex AI Labs",
    "linkedin_url": "https://linkedin.com/in/jordan-lee-example",
    "email": "jordan@vertexailabs.example",
}

# Your LLM call here — the draft goes to approval, not directly to the inbox
draft = generate_outreach_email(prospect)

action_id = push_outreach_for_approval(prospect, draft)

decision = await_decision(action_id)

if decision["status"] == "approved":
    # final_preview carries your edits — never use the original draft here
    approved_body = decision["decision"]["final_preview"]["body"]
    send_email(to=prospect["email"], body=approved_body)
    report_result(action_id, "executed")
else:
    # rejected or expired — do not send, optionally log and skip
    print(f"Skipped {prospect['name']}: {decision['status']}")
```

---

## When you edit the draft

Setting `"editable": ["preview.body"]` lets you rewrite the message body in the approval card before approving. The decision response carries both `decision.final_preview` (what the agent should use) and `decision.diff` (a unified diff if anything changed).

Always pass `final_preview.body` to your send function, not the original draft. When you haven't changed anything, the field still holds the approved content — the API is consistent either way.

This is the most useful feature for outreach specifically. The agent gets the personalisation logic right (referencing the right company, the right hook); you fix the phrasing in two seconds before it goes out.

---

## Expiry as a built-in quality filter

Every action has an `expires_in` (in seconds; minimum 300, maximum 30 days; default 72 hours). An expired action cannot be approved — the status becomes `expired` and polling exits without sending.

For outreach, this is a feature. An email drafted in response to a prospect's blog post from yesterday has a narrow relevance window. Setting `expires_in: 43200` (12 hours) means a draft you missed in your inbox simply disappears rather than going out days later when the context has changed.

Treat `expired` the same as `rejected` in your agent logic: log it, skip the send, and move on.

---

## Impri is the gate, not the sender

Impri stores the draft, notifies you (via email, Slack, Telegram, or web push — configure in [notifications](notifications.md)), and holds the decision. It does not look at the prospect data, does not interpret what kind of outreach it is, and does not execute the send. Your agent owns the send call; Impri owns the yes/no. This division is intentional — it keeps the approval surface small and auditable.

The gate is real only as long as the agent's path to `send_email()` goes through the Impri response. If your agent also holds a direct email credential it can use without approval, the gate doesn't hold.

---

## Next step

If this is your first Impri integration, start with the [quickstart](quickstart.md) to get your API key and send a test action. For more on the Python SDK helper methods (including a built-in polling loop), see [sdk-python](sdk-python.md).
