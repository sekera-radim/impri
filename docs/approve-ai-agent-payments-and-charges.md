# Approve Payments Before Your AI Agent Charges a Card

Approve payments before your AI agent charges a card — review the vendor, amount, and card on file so no charge fires without a human saying yes.

---

## The problem with autonomous spend

Agents that manage ad budgets, top up cloud credits, or renew a vendor subscription eventually need to move money. That's a different risk class than sending an email or posting a tweet: a wrong or duplicated email is embarrassing, a wrong or duplicated charge is a chargeback, a support ticket, and possibly a compliance question. If the agent's only path to charging a card runs through a human decision first, a hallucinated amount or a mis-parsed invoice never reaches the payment provider at all.

The pattern is the same three-call gate used for any other action — push, poll, execute — but payments warrant two adjustments: the amount should not be editable by the reviewer, and the action should be marked so the approval card visibly warns that retrying it is unsafe.

---

## Wiring the gate with the TypeScript SDK

A spend agent that tops up an ad account when the daily budget drops below a floor:

```typescript
import { ImpriClient, ImpriRejected, ImpriTimeout } from '@impri/sdk'

const impri = new ImpriClient({ apiKey: process.env.IMPRI_API_KEY! })

async function topUpAdBudget(vendor: string, amountUsd: number, cardLast4: string) {
  const action = await impri.createAction({
    kind: 'payment.charge',
    title: `Top up ${vendor} ad budget — $${amountUsd.toFixed(2)}`,
    preview: {
      format: 'markdown',
      body: `**Vendor:** ${vendor}\n**Amount:** $${amountUsd.toFixed(2)}\n**Card:** •••• ${cardLast4}\n\nDaily budget dropped below the $50 floor; campaigns pause otherwise.`,
    },
    payload: { amount: amountUsd, currency: 'USD', vendor },
    expiresIn: 3600, // 1 hour — a paused campaign can wait that long
    editable: [],    // binary approval only, see below
  })

  try {
    const decided = await impri.awaitDecision(action.id, { timeoutS: 3600 })
    await chargeCard(vendor, amountUsd, cardLast4)   // your payment provider call
    await impri.reportResult(decided.id, 'executed')
  } catch (e) {
    if (e instanceof ImpriRejected) {
      console.log('Top-up declined — campaigns stay paused until someone reviews spend manually.')
    } else if (e instanceof ImpriTimeout) {
      console.log('No decision within the hour — treat this run as not approved.')
    } else {
      throw e
    }
  }
}
```

`chargeCard` sits inside the `try` block after `awaitDecision` resolves — there's no branch that reaches it on rejection or timeout.

---

## Why payment approvals should not be editable

For a drafted email or social post, letting the reviewer tweak the wording before approving is the whole point. For a charge, it's the opposite: if the reviewer could edit `preview.body` and change the number, they'd be approving a different transaction than the one your reconciliation and idempotency logic expects — the card, the vendor, and the amount need to match what the agent actually submitted. Set `editable: []` on payment actions. The reviewer's job is binary: this exact charge, yes or no.

---

## Marking the charge as non-idempotent

`POST /v1/actions` accepts an `idempotent` hint and an `undo` description that show up directly on the approval card. For a charge, both are worth setting:

```bash
curl -X POST https://api.impri.dev/v1/actions \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "payment.charge",
    "title": "Renew Acme Corp annual plan — $1,200.00",
    "preview": { "format": "plain", "body": "Card ending 4242, vendor: Acme Corp" },
    "idempotent": false,
    "undo": "Refund through the Stripe dashboard or the payment providers refund API"
  }'
```

`idempotent: false` puts a "retrying may duplicate this action" badge on the card — useful context if an agent retry loop somehow pushed the same charge twice. `undo` tells the reviewer the escape hatch up front, before they approve, not after something's already gone wrong.

---

## Auto-approving the ones that don't need a human

Not every charge needs a person to look at it. [Impri's rules engine](rules.md) evaluates `payload_conditions` against the `payload` field you send, so a small recurring top-up can skip the queue while anything larger still waits for a human:

```json
{
  "name": "Auto-approve small ad top-ups",
  "kind_pattern": "payment.*",
  "payload_conditions": [
    { "path": "amount", "op": "lt", "value": 25 },
    { "path": "currency", "op": "eq", "value": "USD" }
  ],
  "rule_action": "auto_approve"
}
```
Set a second rule with `rule_action: "escalate"` on larger amounts if you want those routed to a specific Slack or Telegram channel instead of the default notification.

---

## What happens on rejection, timeout, or expiry

`ImpriRejected` and `ImpriTimeout` are normal outcomes, not errors — a rejected top-up just means the campaign stays paused until a human tops it up manually or approves the next attempt. Impri never decides whether a charge is a good idea; it stores the proposed charge, notifies someone, and holds the decision. The judgment about whether $1,200 for an annual renewal is reasonable stays entirely with the person who taps approve, and [the audit log](audit-log.md) keeps a record of exactly who approved which charge and when.

Next step: [the TypeScript SDK reference](sdk-typescript.md) for the full `createAction`/`awaitDecision`/`reportResult` API this example uses.
