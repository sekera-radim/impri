# Human-in-the-Loop vs Full Autonomy for AI Agents

Deciding when an AI agent should act on its own versus wait for a human — a risk-based framework with concrete thresholds, not a blanket policy.

---

## "Should this agent be autonomous?" is the wrong question

It's usually asked about the whole agent — "is our support bot autonomous or not?" — when the honest answer is almost always "it depends which action." A support agent that looks up order status needs no gate. The same agent issuing a refund does. Treating autonomy as a single on/off switch for an entire agent either blocks it on things that don't matter, which trains reviewers to rubber-stamp everything, or lets it run free on things that do.

The more useful unit isn't the agent, it's the action.

## A risk-based framework

Sort actions by two things: how hard they are to undo, and how bad it is if the agent is wrong. Gate on that, not on how impressive the agent's reasoning looked in the transcript.

| Risk tier | Example action | Reversible? | Autonomy level |
|---|---|---|---|
| Low | Read a record, draft a reply, query an API | Yes — no side effect | Full autonomy |
| Medium | Post a scheduled tweet, update a CRM field | Yes — can be edited/deleted after | Autonomy with logging, spot-check |
| High | Send an email, post publicly, message a customer | Hard — the recipient already saw it | Human-in-the-loop, every time |
| Critical | Refund a charge, delete a record, deploy code | No, or expensive | Human-in-the-loop, no exceptions |

Most teams that say "our agent is fully autonomous" mean the low tier. Most teams that say "we require approval for everything" are gating the low tier too, which is why reviewers stop reading the cards after a week.

## Encoding the framework, not just describing it

The point of a framework is that it's checkable in code, not just written in a doc nobody rereads. A minimal router looks like this:

```python
import os
from impri import ImpriClient

impri = ImpriClient(api_key=os.environ["IMPRI_API_KEY"])

# Tier lookup keyed by action kind — the actual policy, in one place
GATE_REQUIRED = {
    "record.read": False,
    "crm.field_update": False,
    "email.send": True,
    "social.post": True,
    "payment.refund": True,
    "record.delete": True,
}

def run_action(kind: str, title: str, preview_body: str, execute_fn):
    if not GATE_REQUIRED.get(kind, True):  # unknown kinds default to gated
        return execute_fn(preview_body)

    action = impri.actions.create(
        kind=kind,
        title=title,
        preview={"format": "markdown", "body": preview_body},
        editable=["preview.body"],
        expires_in=3600,
    )
    decision = impri.actions.await_decision(action.id, timeout_s=1800)
    if decision.status != "approved":
        return None  # rejected or expired — never executed

    result = execute_fn(decision.final_preview["body"])
    impri.actions.report_result(action.id, status="executed")
    return result
```

The default (`True` for unknown kinds) matters more than the table: a new action kind nobody classified yet should fail toward asking, not toward running.

## Where full autonomy still needs a leash

Even low-risk actions benefit from a ceiling, not because any single one is dangerous, but because volume changes the risk profile. A hundred read-only lookups a minute is fine; a hundred emails a minute from an agent stuck in a loop is not, no matter how each individual email looked. Rate limiting the write path — Impri caps `POST /v1/actions` at 60/minute per key — catches exactly this failure mode even for tiers you've decided don't need per-action review. See [guardrails for real-world agent actions](ai-agent-guardrails-for-real-world-actions.md) for the broader pattern.

## Where human-in-the-loop is non-negotiable

Two conditions make the gate mandatory rather than a judgment call: the action is hard to undo, and the input the agent is acting on is untrusted. An agent drafting a refund based on a customer's own support ticket is one thing; an agent drafting a refund based on a scraped web page that could contain injected instructions is another. Content from RSS feeds, web pages, or public forums should always route through a gate before it triggers a side effect — see [preventing prompt injection from executing actions](prevent-prompt-injection-from-executing-actions.md).

## What this framework doesn't solve

Choosing the right tier is still a judgment call, and Impri doesn't make that call for you — it holds the decision once you've decided an action needs one. It also doesn't rewrite the table when your product changes; a `crm.field_update` that seemed low-risk becomes high-risk the day that field starts triggering an automated billing change downstream. Revisit the table when the *consequences* of an action change, not just when the action itself changes.

For the mechanics of defining these tiers as enforced rules rather than an inline dictionary, see [rules](rules.md).

**Next step:** [quickstart](quickstart.md) to get an API key, then wire the router above around your riskiest action kind first.
