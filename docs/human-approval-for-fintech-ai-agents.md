# Human Approval for Fintech AI Agents

Payment, payout, and account-action agents in fintech need more than a confirmation prompt — they need an auditable human decision before money or data moves. Here's the pattern.

---

## Why "just ask the model to confirm" doesn't hold up

A fintech agent that initiates payouts, opens accounts, or flags transactions for review is one bad prompt injection or hallucinated amount away from a real financial mistake. Compliance teams also tend to ask a second question beyond "did a human check this": *who* checked it, *when*, and *what exactly did they see*. A system prompt instruction to "confirm before sending" produces none of that — no record, no enforcement, nothing to show an auditor.

What's needed instead is a gate outside the model: the agent proposes the transaction, a specific human approves or rejects it, and the decision is the only thing that unlocks execution — with a timestamped record of what was shown and who acted on it.

---

## Gating a payout agent

Say an agent monitors expense reports and initiates reimbursement payouts for anything under a threshold, escalating larger ones. Using the Python SDK's `requires_approval` decorator keeps the gate close to the function that actually moves money:

```python
from impri import ImpriClient, ImpriRejected

client = ImpriClient(api_key=os.environ["IMPRI_API_KEY"])

@client.requires_approval(
    kind="payout.initiate",
    title=lambda emp, amount: f"Reimbursement payout: {emp.name}, ${amount / 100:.2f}",
    preview=lambda emp, amount: {
        "format": "markdown",
        "body": f"Employee: {emp.name} ({emp.id})\nAmount: ${amount / 100:.2f}\nExpense report: {emp.report_url}",
    },
    expires_in=14400,   # 4 hours — payouts shouldn't sit stale
)
async def send_payout(emp, amount_cents: int):
    return await payments_api.create_payout(account=emp.bank_account, amount=amount_cents)

try:
    result = await send_payout(employee, amount_cents=48200)
except ImpriRejected:
    logger.info("Payout rejected by reviewer, expense report flagged for manual follow-up")
```

The decorator pushes the action, blocks until a human decides, and only calls `payments_api.create_payout` on approval — a rejection raises `ImpriRejected` and `create_payout` is never reached. Mark payout actions `idempotent=False` (the default assumption Impri makes when the field is omitted is "unknown" — set it explicitly for anything that moves money) so the reviewer sees a warning if a retry is attempted.

---

## Fintech action types and what they need

Not every fintech-adjacent agent action carries the same risk. A rough mapping:

| Action | Gate? | Notes |
|---|---|---|
| Initiate payout / transfer | Always | Set `idempotent: false`, short `expires_in` |
| Flag a transaction as fraudulent | Usually | Reviewer should see the transaction detail, not just a flag |
| Open or close an account | Always | High-consequence, low-frequency — a slower `expires_in` (hours) is fine |
| Read/summarize transaction history | No | Read-only, no side effect |
| Draft a customer support reply | Maybe | Gate if it discusses balances or disputes; use `editable` so the reviewer can fix wording |

---

## Building the audit trail compliance will ask for

Every decision Impri records carries who acted (`decision.decided_at`, the reviewer identity from the channel they approved through), what they saw (the `preview` at decision time), and — if they edited it — the `diff` between what the agent proposed and what was approved. That combination is closer to what a compliance review needs than an application log line saying "payout sent."

Pull the trail programmatically instead of screenshotting the inbox:

```python
async for action in client.iter_actions(kind="payout.initiate", status="approved"):
    print(action.id, action.decision.decided_at, action.decision.final_preview)
```

See [the audit log doc](audit-log.md) for what's retained and for how long. If your compliance process needs different transactions routed to different reviewers (e.g., payouts over $10k to a senior approver), build that with [rules](rules.md) rather than branching logic in the agent itself — keeping routing declarative makes it easier to show an auditor how a given amount got assigned its reviewer.

---

## What Impri does not give you here

Impri is the approval gate, not a compliance engine. It does not classify transactions as high-risk, does not run KYC/AML checks, and does not itself satisfy any specific regulatory framework (SOC 2, PCI DSS, etc.) — it gives you the primitive (proposal → human decision → audit record) that a compliance program can be built on top of. And the gate only holds if `payments_api.create_payout` is unreachable except through the approved path — an agent that also holds a raw payments API key with no wrapper can bypass it entirely. Keep payment credentials inside the service that enforces the gate, not in the agent's own tool access.

The Python SDK used above is pre-release (v0.1) — install from the repo's `sdk/python` source rather than PyPI for now; the REST API underneath it is stable. See [the SDK docs](sdk-python.md) for the full method list including `bulk_decide` for reviewing a batch of payouts at once.

---

## Next step

Start with [the quickstart](quickstart.md) to get an API key, then wrap your payout or account-action function with `requires_approval` as shown above.
