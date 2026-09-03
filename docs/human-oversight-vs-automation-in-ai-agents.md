# Human Oversight vs Automation in AI Agents

Full automation is fast until it's wrong in public. This page gives a concrete way to decide, action by action, when an AI agent should run free and when it should wait for a human.

---

## The spectrum, not a switch

"Human in the loop" is usually framed as binary — either the agent is autonomous or a person approves everything. In practice almost every real agent sits on a spectrum, and the right position depends on the *action*, not the agent as a whole. A support agent that drafts replies might auto-send a password-reset link (low stakes, easily reversible) while holding a refund over $200 for approval (real money, hard to undo).

The decision comes down to two questions for each action type:

1. **What happens if the agent is wrong?** Reversible and cheap, or public and costly?
2. **How often is the agent actually wrong here?** A well-tested classification step fails less than open-ended generation into an external channel.

Low blast radius + low error rate → automate. High blast radius or unproven accuracy → gate it.

---

## A concrete example: a support ticket agent

Say you're building an agent that triages and answers inbound support tickets. It has several action types, each with a different risk profile:

| Action | Reversible? | Blast radius | Decision |
|---|---|---|---|
| Tag/categorize a ticket | Yes | Internal only | Automate |
| Look up order status | Yes (read-only) | Internal only | Automate |
| Send a canned FAQ reply | Yes (can follow up) | Customer-visible | Automate, log it |
| Send a custom-written reply | Hard — email is sent | Customer-visible, brand risk | Human approval |
| Issue a refund | No | Real money | Human approval |
| Close account on request | No | Data loss | Human approval |

The pattern: read operations and low-risk internal state changes run unattended. Anything that leaves the system as customer-facing text or moves money waits for a person. This is the same logic behind [human-in-the-loop design in general](how-to-add-human-approval-to-an-ai-agent.md) — the gate isn't "is this an AI action," it's "can this action hurt me if the model got it wrong."

---

## Wiring the decision into code

The cleanest way to implement this is a policy function the agent consults before acting, rather than scattering `if` statements through the codebase:

```python
import os
import time
import requests

IMPRI_KEY = os.environ["IMPRI_API_KEY"]
BASE = "https://api.impri.dev"

AUTO_APPROVE = {"ticket.tag", "order.lookup", "reply.faq_canned"}

def handle_action(kind: str, title: str, body: str, execute_fn):
    if kind in AUTO_APPROVE:
        return execute_fn()

    # everything else waits for a human
    resp = requests.post(
        f"{BASE}/v1/actions",
        headers={"Authorization": f"Bearer {IMPRI_KEY}"},
        json={
            "kind": kind,
            "title": title,
            "preview": {"format": "markdown", "body": body},
            "expires_in": 3600,
            "editable": ["preview.body"],
        },
    ).json()
    action_id = resp["id"]

    while True:
        result = requests.get(
            f"{BASE}/v1/actions/{action_id}",
            headers={"Authorization": f"Bearer {IMPRI_KEY}"},
        ).json()
        if result["status"] != "pending":
            break
        time.sleep(10)

    if result["status"] == "approved":
        final_body = result["decision"]["final_preview"]["body"]
        outcome = execute_fn(final_body)
        requests.post(
            f"{BASE}/v1/actions/{action_id}/result",
            headers={"Authorization": f"Bearer {IMPRI_KEY}"},
            json={"status": "executed"},
        )
        return outcome

    return None  # rejected or expired — do nothing
```

The `AUTO_APPROVE` set is the whole policy. Moving an action type between automated and gated is a one-line change, and the audit trail for gated actions comes for free from Impri's [inbox](inbox.md) and [audit log](audit-log.md) — you don't have to build approval bookkeeping yourself.

---

## Signals that an action should move from automated to gated

Static risk tables go stale. Watch for these signals in production and re-classify:

- **Near-miss reports.** A human catches something wrong after the fact, even if no damage was done — that's a signal the action was under-gated, not proof it's fine.
- **Rising ambiguity.** If an action type increasingly depends on judgment calls (tone, exceptions to policy, edge cases the model wasn't trained on), automation confidence should drop with it.
- **New blast radius.** Adding a new channel (say, the agent now posts to a public status page, not just internal Slack) changes the risk calculation even if the underlying logic didn't change.

Conversely, an action gated today can graduate to automated once you have enough approved-without-edits history to trust it — [rules](rules.md) can encode that kind of threshold instead of relying on someone remembering to flip a flag.

---

## What this doesn't solve

Deciding *which* actions need a human is a policy problem you have to own — Impri does not classify risk for you, and it doesn't know your business's tolerance for a wrong refund versus a wrong ticket tag. What it provides is the mechanical part: once you've decided an action needs a human, it stores the proposal, notifies someone, and blocks execution until they decide. The judgment call stays yours; the plumbing doesn't have to be.

Ready to wire this into your agent? Start with the [quickstart](quickstart.md) to get an API key, then see [the full integration guide](how-to-add-human-approval-to-an-ai-agent.md) for the request/response details.
