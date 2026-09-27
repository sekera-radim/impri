# Human-in-the-Loop for AI Agents on Temporal Workflows

Add human-in-the-loop approval to an AI agent running on Temporal: push the proposed action to Impri, sleep durably in the workflow, and execute only on approval.

---

## Why Temporal alone doesn't give you the approval UI

Temporal is very good at the hard part of waiting: a workflow can sit for days, survive worker restarts, and resume exactly where it stopped. What it does not give you is the human side — somewhere for a person to see the proposed action, edit it, and say yes or no from their phone.

The usual answer is a signal plus a custom admin page. That works, but you end up building the inbox, the notifications, the expiry rules and the audit trail yourself. This page shows the other split: **Temporal owns the waiting, Impri owns the decision.**

Impri is only the approval gate. It stores the proposed action, notifies a human, and holds the decision. It does not run your workflow, call your tools or execute anything — your activities do that.

---

## The shape of the workflow

Three activities and one loop:

| Step | Where it runs | What it does |
|---|---|---|
| `pushAction` | Activity | `POST /v1/actions`, returns `id` |
| `getAction` | Activity | `GET /v1/actions/:id`, returns status |
| `sendRefundEmail` (your side effect) | Activity | Runs only after `approved` |
| `reportResult` | Activity | `POST /v1/actions/:id/result` |

The workflow itself stays deterministic: it never touches HTTP. Every network call lives in an activity, and the wait between checks is a durable `sleep`, not a busy loop.

---

## Example (TypeScript)

Activities, using the plain REST API:

```ts
// activities.ts
const BASE = "https://api.impri.dev";
const headers = {
  Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
  "Content-Type": "application/json",
};

export async function pushAction(title: string, body: string): Promise<string> {
  const res = await fetch(`${BASE}/v1/actions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "email.send",
      title,
      preview: { format: "markdown", body },
      expires_in: 86400,
      editable: ["preview.body"],
    }),
  });
  if (!res.ok) throw new Error(`Impri push failed: ${res.status}`);
  return (await res.json()).id;
}

export async function getAction(id: string) {
  const res = await fetch(`${BASE}/v1/actions/${id}`, { headers });
  if (!res.ok) throw new Error(`Impri fetch failed: ${res.status}`);
  return res.json(); // { status, decision: { final_preview, diff } }
}

export async function reportResult(id: string, status: "executed" | "execute_failed") {
  await fetch(`${BASE}/v1/actions/${id}/result`, {
    method: "POST",
    headers,
    body: JSON.stringify({ status }),
  });
}
```

The workflow:

```ts
// workflows.ts
import { proxyActivities, sleep } from "@temporalio/workflow";
import type * as acts from "./activities";

const { pushAction, getAction, reportResult, sendEmail } = proxyActivities<
  typeof acts & { sendEmail(body: string): Promise<void> }
>({ startToCloseTimeout: "30 seconds" });

export async function refundEmailWorkflow(title: string, draft: string) {
  const id = await pushAction(title, draft);

  let action = await getAction(id);
  while (action.status === "pending") {
    await sleep("1 minute"); // durable timer, survives worker restarts
    action = await getAction(id);
  }

  if (action.status !== "approved") return action.status; // rejected | expired

  try {
    // final_preview carries any edits the human made
    await sendEmail(action.decision.final_preview.body);
    await reportResult(id, "executed");
  } catch (err) {
    await reportResult(id, "execute_failed");
    throw err;
  }
  return "executed";
}
```

`expires_in` is in seconds (minimum 300, maximum 30 days, default 72 hours), so the loop always terminates: a request nobody answers ends as `expired` and the email is never sent.

---

## Details that matter in production

- **Make the push idempotent.** Temporal retries failed activities. If `pushAction` succeeds on Impri but the worker dies before recording the result, a retry creates a second inbox item. Keep the retry policy on that activity tight, or store the returned `id` before doing anything else.
- **Execute with `decision.final_preview`, not your original draft.** If you marked `preview.body` as editable, the approved text may differ from what your agent wrote.
- **Poll interval vs. rate limit.** `POST /v1/actions` is limited to 60 requests per minute per key. Polling with `GET` once a minute per workflow is well within reason for human-speed decisions.
- **Report the result.** Calling `/result` with `executed` or `execute_failed` closes the loop in the [audit log](audit-log.md).
- **Do the side effect only in the activity after approval.** The gate is real only when that activity is the agent's sole path to sending. If the agent has a second tool that also sends email, it can bypass the approval.

---

## What this is and isn't

Impri does not replace Temporal, and Temporal does not replace an approval inbox. Impri won't retry your activities, orchestrate steps, or judge whether the action is a good idea. It shows a human the proposal and records the answer. Reviewers can decide from the web [inbox](inbox.md) or through [Slack](slack-approval.md), [Discord](discord-approval.md) or [Telegram](telegram-approval.md).

---

## Next step

Get an API key in the [quickstart](quickstart.md), then read the [general pattern](how-to-add-human-approval-to-an-ai-agent.md) for the request and decision fields in detail. If you'd rather keep everything on your own infrastructure, see [self-hosting](self-hosting.md).
