# Approve AI Agent Outbound Webhooks and Third-Party API Calls

Approve AI agent outbound webhooks and third-party API calls before they fire: review the exact URL, method and payload, then send only after a human says yes.

---

## The problem: an HTTP request is a side effect you can't recall

An agent that can call arbitrary URLs can notify a customer's system, trigger a partner's automation, hit a paid API or post to a service you don't control. Once the request leaves your network, you can't pull it back. A webhook to a partner's billing endpoint with a wrong amount, or a call to a third-party API with a hallucinated parameter, is already someone else's problem.

Outbound calls are also easy to overlook in review, because they look like plumbing. The risky parts are the destination and the body, and both are chosen by a model at runtime.

---

## What the reviewer needs to see

A card that says "call API" is useless. Put the full request into the preview so the human can judge it in a few seconds:

| Field | Why it matters |
|-------|----------------|
| Method and full URL | Catches wrong hosts, staging vs. production, and unexpected domains |
| Redacted headers | Shows which credential would be used, never the secret itself |
| Body | The part the model actually authored |
| Why the agent wants to send it | One line of context from the agent |

Never put the API token or signing secret in the preview. Show a label such as `Authorization: Bearer ****` and keep the real credential on your side.

---

## Example: gate a webhook call before it is sent

The agent pushes the request as an action instead of sending it. `expires_in` is short, because a stale webhook is usually not worth firing.

```python
import os, time, requests

BASE = "https://api.impri.dev"
H = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

def propose_webhook(url: str, payload: dict, reason: str) -> str:
    body = (
        f"**POST** `{url}`\n\n"
        f"**Why:** {reason}\n\n"
        f"```json\n{__import__('json').dumps(payload, indent=2)}\n```"
    )
    r = requests.post(f"{BASE}/v1/actions", headers=H, json={
        "kind": "webhook.send",
        "title": f"POST {url}",
        "preview": {"format": "markdown", "body": body},
        "expires_in": 1800,
        "idempotent": False,
        "undo": "Ask the receiving service to void the event; nothing is reversible on our side",
    })
    r.raise_for_status()
    return r.json()["id"]

def wait(action_id: str) -> dict:
    while True:
        a = requests.get(f"{BASE}/v1/actions/{action_id}", headers=H).json()
        if a["status"] != "pending":
            return a
        time.sleep(10)

action_id = propose_webhook(
    "https://partner.example.com/hooks/order-status",
    {"order_id": "A-1042", "status": "refunded", "amount": 49.0},
    "Customer asked for a refund in ticket #881",
)
decision = wait(action_id)

if decision["status"] == "approved":
    resp = requests.post(
        "https://partner.example.com/hooks/order-status",
        json={"order_id": "A-1042", "status": "refunded", "amount": 49.0},
        headers={"Authorization": f"Bearer {os.environ['PARTNER_TOKEN']}"},
        timeout=15,
    )
    requests.post(f"{BASE}/v1/actions/{action_id}/result", headers=H,
                  json={"status": "executed" if resp.ok else "execute_failed"})
```

Marking the action `idempotent: false` puts a warning badge on the card, so the reviewer knows a retry could duplicate the event.

---

## Common pitfalls

- **Approving one payload, sending another.** Build the request once, show that exact object, and send that same object. Don't let the agent reassemble it after approval.
- **Editable bodies.** If you set `editable: ["preview.body"]` so the human can tweak the text, send `decision.final_preview`, not your original. Only do this when you parse the edited body back into the request safely; for structured JSON, consider leaving it non-editable and rejecting instead.
- **Blanket approval of a whole host.** Gate by action, not by domain. A reviewer who sees a hundred identical cards will stop reading them; for repeated low-risk calls, narrow the gated set rather than rubber-stamping everything.
- **Retries after `execute_failed`.** Report the failure honestly, then propose a new action rather than silently re-sending.

---

## What Impri does and doesn't do here

Impri is the approval gate only. It stores the proposed request, notifies a human and holds the decision. It does not send the HTTP call, inspect the target, validate the payload or know what the endpoint does. Your code performs the request.

It is a real gate only if the wrapped function is the agent's **only** path to that endpoint. If the agent also holds the raw API token and can run `curl` or an unrestricted HTTP tool, it can route around the approval. Keep the credential inside the wrapper, not in the agent's reach.

Impri is not a workflow engine and not a webhook delivery service: there is no retry queue, signing or delivery log for the outbound call. Those stay in your stack.

---

## Next steps

Get a key and run the three calls in the [quickstart](quickstart.md). For the full pattern behind this example, read [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md), and to get decisions on your phone see [notifications](notifications.md). If your agent uses MCP tools, the [MCP guide](mcp.md) shows the same flow without HTTP code.
