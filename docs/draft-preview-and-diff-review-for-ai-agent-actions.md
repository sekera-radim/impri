# Draft Preview and Diff Review for AI Agent Actions

Show a human the exact draft your AI agent wants to send, let them edit it, and execute only the reviewed version. Draft preview and diff review with Impri, in TypeScript.

---

## The problem: approving one thing, sending another

A yes/no button is only as good as what the reviewer saw when they pressed it. If the agent shows a summary ("Send follow-up email to Acme") and then sends a body the human never read, the approval means very little. And if the human spots a bad sentence, "reject" forces a full regeneration when a one-line edit would have done.

The fix is a pattern with three parts: the **preview** is the real artifact, the human can **edit** it in place, and the agent executes the **edited version** rather than its own original.

## Step 1: push the real draft as the preview

The preview is the full text the agent will act on, not a description of it. Mark the fields the human may change with `editable`.

```typescript
const BASE = "https://api.impri.dev";
const headers = {
  Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
  "Content-Type": "application/json",
};

async function proposeReleaseNotes(notes: string) {
  const res = await fetch(`${BASE}/v1/actions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "changelog.publish",
      title: "Release notes for v2.4.0",
      preview: { format: "markdown", body: notes },
      editable: ["preview.body"],
      expires_in: 14400, // 4 hours: stale release notes are worse than none
    }),
  });
  const { id, inbox_url } = await res.json();
  return { id, inbox_url };
}
```

The response gives you `id`, `status: "pending"` and an `inbox_url`. The reviewer opens the card, reads the markdown as rendered text, and can change `preview.body` before approving.

## Step 2: read the decision, not your own draft

Poll `GET /v1/actions/:id` until the status leaves `pending`. On approval, the decision carries the version the human actually approved.

```typescript
async function waitForDecision(id: string) {
  while (true) {
    const res = await fetch(`${BASE}/v1/actions/${id}`, { headers });
    const action = await res.json();
    if (action.status !== "pending") return action;
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

const { id } = await proposeReleaseNotes(draft);
const action = await waitForDecision(id);

if (action.status === "approved") {
  const finalBody: string = action.decision.final_preview.body;
  if (action.decision.diff) {
    // The human changed something. Keep the diff for your own logs.
    console.info("Reviewer edited the draft:\n" + action.decision.diff);
  }
  await publishChangelog(finalBody); // your function, your credentials
  await fetch(`${BASE}/v1/actions/${id}/result`, {
    method: "POST",
    headers,
    body: JSON.stringify({ status: "executed" }),
  });
}
```

Two details matter here. First, always publish `decision.final_preview.body`, never the string you pushed. Second, `decision.diff` is present only when something was actually modified, so treat its absence as "approved as written".

## What the diff is good for

| Use | How |
|-----|-----|
| Cheap feedback signal | Log the diff. Repeated edits to the same kind of sentence tell you what to fix in the prompt. |
| Sanity check before execution | If the diff is huge, your agent can decide to re-validate the final text (length, links) before sending. |
| Audit | The card keeps what was proposed and what was approved. See [the audit log](audit-log.md). |

## Rejected and expired drafts

`rejected` and `expired` both mean "do not execute". Because the draft has a hard expiry, a reviewer who is away does not accidentally approve a stale version later. If the task is still relevant, push a fresh action with an updated draft. More on that in [approval timeouts and expiry](handling-approval-timeouts-and-expiry-in-agents.md).

## Boundaries worth knowing

- Impri stores the preview, notifies the reviewer and holds the decision. It does not generate the draft, judge its quality, or publish anything.
- The diff shows what the human changed in the editable fields. It does not verify that your preview matches what your executor will really do, so build the preview from the same variable you pass to the executor.
- This is a real gate only if `publishChangelog` is the agent's sole route to publishing. If the agent also holds the raw credential, it can bypass the review.

## Next step

Get a key and push your first draft with the [quickstart](quickstart.md). The general three-call flow is in [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md), and the reviewer-side editing flow is covered in [editing agent drafts before approving](edit-ai-agent-drafts-before-approving.md).
