# Human Approval for Solo-Founder AI Automations

Running support replies, invoice follow-ups, and social posts through separate AI agents only works solo if you can review all of it in one five-minute morning sweep instead of babysitting each one live.

---

## The problem is review time, not automation

A solo founder running three or four small agents — a support-ticket responder, an invoice-chasing bot, a social post drafter — doesn't have the bandwidth to sit and watch each one work. But "fully unsupervised" isn't the answer either: one hallucinated refund promise in a support reply, one invoice sent to the wrong customer, one tone-deaf tweet, and you're doing damage control instead of building. What actually scales for one person is a single queue you clear in a batch, not three separate places to check.

## One inbox, one pass, every action gated the same way

Every agent pushes its proposed action to Impri instead of executing directly, regardless of which agent produced it. You get one inbox — web, mobile, or wherever notifications land — and one decision loop instead of three integrations to babysit. Because the gate is identical across agents (`kind` differs, the shape doesn't), you write the wrapper once and reuse it.

```python
import os
from impri import ImpriClient

client = ImpriClient(api_key=os.environ["IMPRI_API_KEY"])

async def propose_support_reply(ticket_id: str, customer_email: str, draft_body: str):
    action = await client.create_action(
        kind="support.reply",
        title=f"Reply to ticket #{ticket_id} ({customer_email})",
        preview={"format": "markdown", "body": draft_body},
        payload={"ticket_id": ticket_id, "customer_email": customer_email},
        editable=["preview.body"],
        expires_in=43200,  # 12 hours — long enough to survive an overnight batch
    )
    return action.id

async def propose_invoice_followup(invoice_id: str, customer: str, days_overdue: int, draft_body: str):
    action = await client.create_action(
        kind="invoice.followup",
        title=f"Chase {customer}: invoice {invoice_id} ({days_overdue}d overdue)",
        preview={"format": "markdown", "body": draft_body},
        editable=["preview.body"],
        expires_in=86400,
    )
    return action.id

async def propose_social_post(platform: str, draft_body: str):
    action = await client.create_action(
        kind="social.post",
        title=f"Post to {platform}",
        preview={"format": "plain", "body": draft_body},
        editable=["preview.body"],
        expires_in=21600,  # stale drafts aren't worth posting a day later
    )
    return action.id
```

Three agents, three `kind` values, one `create_action` call shape. Nothing executes until the corresponding decision comes back approved.

## Clearing the queue in one pass, not three

This is where a solo founder's workflow diverges from a team's: nobody else is going to triage the inbox for you, so the morning routine has to be a single batch clear, not a card-by-card review across separate tools. Impri's bulk-decision endpoint approves or rejects several actions at once from a script, which is the shape a "review everything with coffee" habit actually needs:

```python
pending = await client.list_actions(status="pending", kind="support.reply")
approve_ids = [a.id for a in pending.items if looks_routine(a.preview.body)]

if approve_ids:
    resp = client.bulk_decide(ids=approve_ids, verdict="approve", comment="morning batch")
    print(f"approved {resp['succeeded']}, failed {resp['failed']}")
```

Actions with `editable` fields still route through per-item `decide()` if you want to hand-edit one before approving — `bulk_decide` intentionally skips edits so a batch approval can't silently rewrite fifty drafts at once. In practice: skim the inbox, bulk-approve the obviously-fine replies, open the two that need a tweak individually, reject the rest. That's the whole morning review.

## Why "just trust the agent" doesn't hold at this scale

The instinct to skip a gate entirely is strongest for a solo founder — every extra step feels like it's eating the time automation was supposed to save. But the actions with the most damage per mistake (a wrong refund commitment, a duplicate invoice chase, a post that goes out with the wrong numbers) are exactly the ones a solo operator has the least slack to walk back publicly and alone. A five-minute batch review is cheap insurance against the one incident that costs a weekend.

## What this isn't

Impri doesn't decide which replies are routine, doesn't write the invoice-chase copy, and doesn't know your Twitter voice — your agents own all of that. It stores the proposed action, notifies you, and holds the decision until you clear the queue. And the gate only holds if the agent's actual send/post credentials live behind the approved-decision check, not in the agent's own reach — see [integrations](integrations.md) for wrapping the executor so there's no side door around it.

| Agent | `kind` | Typical review |
|---|---|---|
| Support responder | `support.reply` | Bulk-approve routine ones, edit the rest |
| Invoice chaser | `invoice.followup` | Bulk-approve, reject anything past a write-off threshold |
| Social drafter | `social.post` | Individual review — tone matters more than volume |

---

Next: [quickstart](quickstart.md) to get an API key, [the Python SDK](sdk-python.md) for the full client including `bulk_decide`, and [notifications](notifications.md) to route the whole queue to one phone.
