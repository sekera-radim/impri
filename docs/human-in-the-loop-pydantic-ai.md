# Human-in-the-Loop for Pydantic AI Agents

Add human-in-the-loop for Pydantic AI agents at the tool boundary: wrap a refund tool in Impri's `approval_gate`, and no charge reverses until a person says yes.

---

## Why the tool function, not the system prompt

A Pydantic AI agent with a `stripe.refund`-shaped tool will eventually call it on a customer's word alone, because that's what the system prompt told it to be helpful about. Telling the model "always ask before refunding" in the prompt doesn't hold up once the conversation gets long or the customer is insistent — the instruction is competing with the rest of the context for the model's attention.

The reliable version puts the check in the tool function itself, where the model has no way to talk its way past it. The agent still decides *when* to call `issue_refund` — but the function's body, not the model, decides whether the refund actually happens.

## A refund tool with a human gate

```python
import os
import stripe
from dataclasses import dataclass
from pydantic_ai import Agent, RunContext
from impri import ImpriClient, ImpriRejected, ImpriTimeout

@dataclass
class Deps:
    impri: ImpriClient
    stripe_key: str

agent = Agent(
    "openai:gpt-4o",
    deps_type=Deps,
    system_prompt="You are a billing support agent for a SaaS product.",
)

@agent.tool
async def issue_refund(
    ctx: RunContext[Deps], customer_id: str, amount_cents: int, reason: str
) -> str:
    """Refund a customer. Requires human approval before the charge is reversed."""
    body = f"**Customer:** {customer_id}\n**Amount:** ${amount_cents / 100:.2f}\n**Reason:** {reason}"

    try:
        async with ctx.deps.impri.approval_gate(
            kind="stripe.refund",
            title=f"Refund ${amount_cents / 100:.2f} to {customer_id}",
            preview={"format": "markdown", "body": body},
            editable=["preview.body"],
            timeout_s=600,
        ) as approved:
            refund = stripe.Refund.create(
                customer=customer_id,
                amount=amount_cents,
                reason="requested_by_customer",
                api_key=ctx.deps.stripe_key,
            )
            return f"Refund {refund.id} issued for {customer_id}."
    except ImpriRejected as e:
        return f"Refund not issued — a reviewer rejected it (action {e.action_id})."
    except ImpriTimeout:
        return "Refund not issued — no reviewer decision within 10 minutes."


async def main():
    deps = Deps(impri=ImpriClient(), stripe_key=os.environ["STRIPE_SECRET_KEY"])
    result = await agent.run(
        "Customer cust_9f2 was double-charged on the March invoice, refund $42.00.",
        deps=deps,
    )
    print(result.output)
```

`approval_gate` is the SDK's context-manager form: it pushes the action, blocks until a human decides, and calls `report_result` automatically on the way out — `executed` on a clean exit, `execute_failed` if the `stripe.Refund.create` call inside the block raises. See [Python SDK](sdk-python.md) for the full method reference.

## Handling rejection inside the tool, not outside it

Notice the `try/except` lives *inside* `issue_refund`, wrapping the whole gate. If you let `ImpriRejected` propagate up instead, Pydantic AI's tool-calling loop sees an unhandled exception from a tool call — depending on your retry settings, the agent may interpret that as a transient failure and call `issue_refund` again with the same arguments, which is the last thing you want after a human explicitly said no. Catching it and returning a plain string turns "rejected" into ordinary tool output: the agent reads it, tells the customer no refund went out, and moves on.

## Sync agent, async gate

`approval_gate` is an async context manager, so `issue_refund` has to be declared `async def` and the run driven with `await agent.run(...)` rather than `agent.run_sync(...)`. If the rest of your agent is otherwise synchronous, this one tool is a reason to switch the entry point to the async form — Pydantic AI supports mixing sync and async tools on the same agent, but the gate itself only comes in async.

## What's actually verified, and what isn't

| Exception | What it means | What the tool does |
|---|---|---|
| *(none — approved)* | A human read the card and approved it | Calls Stripe, reports `executed` |
| `ImpriRejected` | A human explicitly declined | Returns a string, Stripe is never called |
| `ImpriTimeout` | No decision within `timeout_s` | Returns a string, action stays pending server-side |

Impri verified that a human looked at exactly the card shown — customer ID, amount, reason — and approved it. It did not verify that `customer_id` is correct, that the amount matches the actual overcharge, or anything about Stripe's response. Those are the agent's and your billing system's job. And the gate only holds if `issue_refund` is the only path from this agent to `stripe.Refund.create` — a second tool with its own Stripe key would bypass it entirely.

## Next step

See [How to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) for the underlying REST pattern, or [Quickstart](quickstart.md) to get an API key before wiring this into a real agent.
