# Human Approval for Background AI Workers

Background AI workers run on a schedule or a queue, retry themselves on failure, and have nobody watching — which turns "just add a confirmation step" into a genuinely hard problem worth solving properly.

---

## The background-worker version of the problem

A chat agent has a person on the other end of the conversation. A background worker — a cron job, a BullMQ/Sidekiq/Celery consumer, a scheduled Lambda — doesn't. It wakes up, does its work, and if that work ends in "send the digest email" or "post the summary to the team channel," there's no natural point where a human would normally intervene. Two things make this worse than the webhook case:

- **Retries.** Queue systems re-run failed jobs automatically. If the job's failure mode is "crashed after sending the email but before marking itself done," a naive retry sends it twice.
- **Silence.** Nobody is watching a live log. If the approval step is a Slack message that scrolls off the channel, it's effectively invisible.

Both point at the same fix: the approval has to be a state the job checks before acting, not a notification the job hopes gets read, and the state has to be safe to check again after a crash.

---

## Example: a nightly digest worker

Say a worker runs every night, summarizes the day's support tickets, and emails the summary to a distribution list. Here's a TypeScript BullMQ-style job that gates the send:

```typescript
import { Worker } from "bullmq";

const IMPRI_BASE = process.env.IMPRI_BASE_URL ?? "https://api.impri.dev";
const IMPRI_KEY = process.env.IMPRI_API_KEY!;

async function pushAction(title: string, body: string) {
  const res = await fetch(`${IMPRI_BASE}/v1/actions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${IMPRI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      kind: "email.send",
      title,
      preview: { format: "markdown", body },
      expires_in: 43200, // 12h — send it before the next day's digest replaces it
      editable: ["preview.body"],
      idempotent: false,
      undo: "No undo — email already delivered if sent in error; follow up with a correction.",
    }),
  });
  return res.json() as Promise<{ id: string; status: string }>;
}

async function awaitDecision(actionId: string) {
  while (true) {
    const res = await fetch(`${IMPRI_BASE}/v1/actions/${actionId}`, {
      headers: { Authorization: `Bearer ${IMPRI_KEY}` },
    });
    const data = await res.json();
    if (data.status !== "pending") return data;
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

new Worker("nightly-digest", async (job) => {
  const summary = await summarizeTickets(job.data.date); // your own logic
  const action = await pushAction(`Nightly digest — ${job.data.date}`, summary);

  const decision = await awaitDecision(action.id);
  if (decision.status !== "approved") {
    return; // rejected or expired — job completes successfully, nothing sent
  }

  await sendEmail(decision.decision.final_preview.body);
  await fetch(`${IMPRI_BASE}/v1/actions/${action.id}/result`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${IMPRI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status: "executed" }),
  });
});
```

---

## Why this survives a queue retry

If the process crashes right after `sendEmail()` but before the `/result` call completes, BullMQ will retry the job. On retry, `job.data.date` is the same, so `summarizeTickets()` re-runs and `pushAction()` creates a **new** action — the old one is left dangling as approved-but-unreported, and the retry pushes a fresh approval request rather than silently re-sending. That's the honest behavior given the API surface here: Impri does not track "did the caller actually execute this," only "was it approved" and whatever you report back via `/result`. If you need stronger de-duplication across retries (e.g. a job-id keyed skip), that has to live in your own worker state — Impri's `idempotent` field is a signal shown to the human reviewer, not an automatic dedupe mechanism.

Setting `idempotent: false` matters here specifically because queue systems retry: it puts a "retrying may duplicate this action" warning on the inbox card, which is exactly the risk a background worker's approver needs to know about that a chat-agent approver usually doesn't.

---

## Where the human actually sees this

Nobody is staring at a terminal for a job that runs at 2am. Route the notification to something that reaches a phone: [Telegram](telegram-approval.md), [Slack](slack-approval.md), or [Discord](discord-approval.md) approval channels, or web push. The `expires_in` of 12 hours in the example above is deliberately long enough to survive a night's sleep but short enough that an approval given the next afternoon doesn't send a day-old digest.

---

## A quick comparison

| Trigger type | Who's watching | Typical `expires_in` | Biggest risk if ungated |
|---|---|---|---|
| Chat agent | The user, live | Minutes to hours | Bad draft sent immediately |
| Webhook-triggered agent | Nobody, but the event is fresh | Minutes to a few hours | Acting on a fast-changing event |
| Background/queue worker | Nobody, and retries happen | Hours | Duplicate side effects from retries |

---

## Next step

Read [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) for the base three-call pattern, then [quickstart](quickstart.md) to get a key and pick a notification channel that reaches you outside working hours.
