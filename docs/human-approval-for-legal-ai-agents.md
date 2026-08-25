# Human Approval for Legal AI Agents

Give an AI agent that drafts contract clauses or client correspondence a real stop-and-check gate — an attorney decides, the agent only sends what was approved.

---

## The problem

A legal-drafting agent that redlines a contract clause, or drafts a reply to opposing counsel, is producing text that carries legal weight the moment it goes out. Unlike most SaaS automation, there's no cheap undo: a sent email is discoverable, a filed clause is binding once countersigned. Firms that let an agent draft this kind of content almost always want a named attorney to sign off before anything leaves the building — not a confirmation checkbox inside the agent's own reasoning, which can be talked past by the same model that wrote the draft.

Impri's job here is narrow: hold the draft, notify the attorney, and only release `approved` once a human decided. It has no opinion on whether the clause is enforceable.

---

## Wiring it up — TypeScript

```typescript
import { setTimeout as sleep } from "node:timers/promises";

const BASE = "https://api.impri.dev";
const KEY = process.env.IMPRI_API_KEY!;

type Decision = {
  status: "pending" | "approved" | "rejected" | "expired";
  decision?: { final_preview: { body: string }; diff?: string };
};

async function proposeClause(matter: string, clauseDraft: string, docUrl: string): Promise<string> {
  const res = await fetch(`${BASE}/v1/actions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "contract_clause.propose",
      title: `Redline for review: ${matter}`,
      preview: { format: "markdown", body: clauseDraft },
      target_url: docUrl,
      expires_in: 172800, // 48h — attorneys review on their own schedule, not agent time
      editable: ["preview.body"],
      undo: "Discard the redline; no changes are applied until an attorney separately merges it.",
    }),
  });
  const { id } = await res.json();
  return id;
}

async function awaitAttorneyDecision(actionId: string, timeoutMs = 24 * 3600_000): Promise<Decision> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/v1/actions/${actionId}`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    const result: Decision = await res.json();
    if (result.status !== "pending") return result;
    await sleep(15_000);
  }
  throw new Error("attorney did not decide before deadline");
}

async function applyIfApproved(actionId: string, decision: Decision, apply: (text: string) => Promise<void>) {
  if (decision.status !== "approved" || !decision.decision) return;
  await apply(decision.decision.final_preview.body);
  await fetch(`${BASE}/v1/actions/${actionId}/result`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "executed" }),
  });
}
```

Note the `undo` field: it's descriptive text shown on the approval card, not a real rollback mechanism Impri executes. For contract clauses that's the honest answer anyway — the safe "undo" is that nothing was ever merged until a human said yes.

---

## What the attorney sees and controls

| Reviewer action | Result |
|---|---|
| Approves as-is | `decision.final_preview.body` equals the original draft |
| Edits the clause text, then approves | `decision.final_preview.body` carries the edit; `decision.diff` shows what changed |
| Rejects | Agent must not apply anything; treat like the clause never existed |
| Lets it expire (48h passes) | Same as rejected — stale legal drafts should not be applied without a fresh review |

Because `editable: ["preview.body"]` is set, the attorney's markup happens directly in the approval UI rather than in a separate redline tool — useful for small wording fixes, not a replacement for full document review when the change is substantial.

---

## Where this fits, and where it doesn't

Impri is the approval gate only — it doesn't understand contract law, doesn't flag risky clauses, and doesn't replace your document management or e-signature system. Use it for the specific moment where an agent-generated draft needs a named human's yes/no before it moves to the next step (sending, merging, filing). It is not a workflow engine: if a clause needs review by two different attorneys in sequence, chain two Impri actions or run it as a step inside something like n8n or Temporal that owns that sequencing.

The gate is only as strong as the wrapper around it, too. If the agent retains direct API access to your document system or email client, wrap that access so the "send" or "merge" function can only be called with an `approved` decision object — not just at the point shown in the example above.

---

## Next step

Read [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) for the underlying pattern, [the TypeScript SDK](sdk-typescript.md) if you'd rather not hand-roll the fetch calls, and [integrations](integrations.md) for wrapping the actual send/merge tool so Impri is the only path to it.
