# Human-in-the-Loop for AI Customer Support Agents

A support agent that drafts replies is safe. One that also sends them, issues refunds, or cancels accounts needs a human in the loop before any of that reaches a customer.

---

## Where support agents actually go wrong

Most AI support setups fail the same way: the model is good at drafting a plausible-sounding reply, but "plausible-sounding" and "correct" are different things. A customer says their order never arrived, and the agent — trusting the customer's framing without checking the shipment record — offers a full refund plus a discount code. A customer asks to close their account, and the agent, trying to be helpful, does it immediately instead of confirming they understand it's irreversible.

None of this requires the model to be malicious or even particularly wrong. It just needs to be confidently overconfident, which is the default mode for most LLMs. The fix isn't a better prompt telling it to "be careful with refunds" — that's advice the model can and will talk itself past under the right conversational pressure. The fix is a gate the agent's code cannot route around: draft the reply or the refund, submit it for approval, and only call the real API once a human has said yes.

---

## Triage: what needs a human, what doesn't

Not every support action deserves an approval step — that would just turn your inbox into a bottleneck. A reasonable split:

| Action | Approve first? |
|---|---|
| Answering a "how do I reset my password" FAQ | No |
| Replying with account-specific details (order status, balance) | No, if read-only |
| Issuing a refund or credit | Yes |
| Cancelling or downgrading a subscription | Yes |
| Replying to an angry or legal-sounding message | Yes |
| Escalating to a human teammate | No — that's already the safe path |

The pattern below applies to any of the "yes" rows; refunds specifically are covered in more depth in [approving refunds issued by an AI support agent](approve-refunds-issued-by-an-ai-support-agent.md).

---

## Wiring the gate with the Python SDK

Here's a support agent that drafts a reply to a billing complaint and won't send it until approved:

```python
import time
from impri import ImpriClient

client = ImpriClient(api_key=os.environ["IMPRI_API_KEY"])

def handle_billing_ticket(ticket):
    draft = generate_reply(ticket)  # your LLM call, not shown

    action = client.actions.create(
        kind="support.reply",
        title=f"Reply to ticket #{ticket.id}: {ticket.subject}",
        preview={"format": "markdown", "body": draft},
        target_url=ticket.helpdesk_url,
        expires_in=3600,          # a support ticket goes stale fast
        editable=["preview.body"],
    )

    while True:
        result = client.actions.get(action.id)
        if result.status != "pending":
            break
        time.sleep(5)

    if result.status == "approved":
        final_body = result.decision.final_preview["body"]
        helpdesk.post_reply(ticket.id, final_body)
        client.actions.report_result(action.id, status="executed")
    else:
        # rejected or expired — escalate to a human agent instead
        helpdesk.assign_to_queue(ticket.id, queue="human-review")
```

The important detail is `editable=["preview.body"]` — a support lead can fix the tone or the numbers before approving, and `final_preview` (never the original draft) is what actually gets sent. If the ticket sits unreviewed for an hour, it expires rather than going out stale, and the fallback path routes it to a real person instead of silently dropping it.

---

## Give reviewers enough to decide fast

A support lead approving from their phone between other tickets doesn't have time to re-read the whole thread. Put the decision-relevant facts in the title and keep the preview body to what's actually being sent — not a dump of internal context. If the action depends on something the reviewer can't see in the preview (e.g., "this customer has churned twice before"), that belongs in your ticket system, not stuffed into the approval card.

For refunds and other actions with financial impact, set `idempotent: false` in the action payload so the approval card shows a warning against approving it twice — see the optional fields in [the main integration guide](how-to-add-human-approval-to-an-ai-agent.md).

---

## Boundaries worth being explicit about

Impri is the approval gate — it stores the draft reply, notifies the reviewer, and holds the decision. It does not read the support ticket, judge whether the refund amount is reasonable, or understand your helpdesk's data model. That judgment stays with the human reviewer and with your agent's own logic for what to draft in the first place.

It's also only a real gate if `helpdesk.post_reply` and `refund_api.issue` are unreachable except through this code path. If your support agent also holds a raw API key it could call directly, wrap that client so the unapproved path doesn't exist in the code — see [SDK integrations](integrations.md) for the wrapper pattern, and [approve emails before your AI agent sends them](approve-emails-before-your-ai-agent-sends-them.md) if replies go out over email specifically.

Next step: [quickstart](quickstart.md) to get an API key and try this against a real ticket.
