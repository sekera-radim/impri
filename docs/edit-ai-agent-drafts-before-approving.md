# Edit AI Agent Drafts Before You Approve Them

Let a human fix a typo or soften a line in an AI agent's draft before approving it, so the agent executes exactly the edited version — not the original.

---

## Reject is too blunt for a draft that's 90% right

Picture a marketing agent that drafts LinkedIn posts from a changelog entry. Most of the copy is good. But the AI wrote "revolutionary" for a bug fix, or got a product name wrong. Rejecting the whole thing means the agent regenerates from scratch and you review again — for a one-word fix. What you actually want is to edit the text inline and approve the edited version.

Impri supports this directly: mark specific fields `editable` when you push the action, and the human reviewer can modify them in the inbox card before approving. The agent then executes whatever the human left behind, not what it originally proposed.

---

## Marking a field editable

```typescript
import { ImpriClient } from "@impri/sdk";

const impri = new ImpriClient({ apiKey: process.env.IMPRI_API_KEY! });

async function proposePost(changelogEntry: string, draft: string) {
  const action = await impri.actions.create({
    kind: "social.post",
    title: `LinkedIn post: ${changelogEntry}`,
    preview: { format: "markdown", body: draft },
    editable: ["preview.body"],
    expires_in: 172800, // give the reviewer two days, this isn't urgent
  });
  return action.id;
}
```

`editable` is an array of paths, not a boolean toggle on the whole action — you decide precisely which fields a human is allowed to touch. Here it's just the body text; the `kind` and `title` stay fixed regardless of what the reviewer does in the inbox UI.

---

## What comes back after a decision

Poll or `await` the decision the same way as any other action. The difference shows up in the payload: when the reviewer edited something, `decision.final_preview` holds their version and `decision.diff` shows what changed.

```typescript
const decision = await impri.actions.awaitDecision(actionId, { timeoutS: 172800 });

if (decision.status === "approved") {
  const finalBody = decision.final_preview.body; // always use this, never the original draft
  if (decision.diff) {
    console.log("Reviewer edited the draft:\n", decision.diff);
  }
  await postToLinkedIn(finalBody);
  await impri.actions.reportResult(actionId, { status: "executed" });
}
```

`final_preview` is populated whether or not anything was actually edited — if the reviewer approved untouched, it's identical to the original `preview`. `diff` only appears when something changed, so checking for its presence is a cheap way to log or audit edits without diffing yourself.

---

## editable vs. reject-and-retry

Both are valid; which one fits depends on how far off the draft is.

| Situation | Better approach |
|---|---|
| Wrong word, minor tone fix, a name to correct | `editable`, let the human fix it inline |
| Draft is based on a wrong premise entirely | Reject, have the agent regenerate with feedback |
| Structured fields like an amount or a target ID | Do not mark these editable — validate and regenerate instead |
| Reviewer should be able to see exactly what changed for audit purposes | `editable` — the `diff` gives you that for free |

Avoid making highly structured fields (prices, recipient addresses, account IDs) editable free-text — a typo'd dollar amount that a reviewer approves without noticing is worse than forcing a clean regenerate. Keep `editable` to prose fields like `preview.body`.

---

## What Impri does not do here

Impri stores the edit and hands you `final_preview` and `diff` — it does not validate that the edit makes sense, check it against a schema, or diff it against your business rules. If the reviewer pastes something unrelated into the body, that's what gets approved. The gate is "a human looked at this and signed off on this exact text," not "this text passed a content check." If you need the latter, validate `final_preview` in your own code before executing, the same way you'd validate any external input.

Next: [quickstart](quickstart.md) to get an API key, or [the TypeScript SDK](sdk-typescript.md) for the full client reference.
