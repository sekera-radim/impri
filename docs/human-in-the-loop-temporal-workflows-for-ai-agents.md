# Temporal Human-in-the-Loop with an Approval Inbox

A Temporal workflow waits for a human with a signal and a durable timer. Impri adds the approval inbox: a signed webhook wakes it when someone decides.

*Updated 2026-11-16. Tested with the Temporal TypeScript SDK 1.25.0 on a local dev server, against a self-hosted Impri server.*

---

## What Temporal gives you, and what it leaves to you

Temporal's own [human-in-the-loop recipe](https://docs.temporal.io/ai-cookbook/human-in-the-loop-python) pauses the workflow with `wait_condition` until a Signal brings the decision or a timeout runs out (5 minutes by default). The wait survives worker restarts and uses no compute while it lasts.

In the recipe, the "UI" is a script you run in a terminal to send the signal. In production a person has to see the proposed action, perhaps fix the wording, and answer from wherever they are. You also want an expiry and a record of who decided. That part is Impri's:

| Concern | Temporal | Impri |
|---|---|---|
| Durable wait, retries, resume | yes | no |
| Card with the proposed action, editable text | no | yes |
| Reach the reviewer (web inbox, Slack, Discord, Telegram) | no | yes |
| Nobody answers | your timer | `expires_in`, then status `expired` |
| Who decided, when | workflow history | [audit log](audit-log.md) |
| Running the action | your activity | never |

Impri is only the gate. It stores the proposal, notifies a human and records the answer. Your activities do the work.

---

## How the pieces connect

1. An activity creates the Impri card with an `idempotency_key` and a `callback_url` that carries the workflow ID.
2. The workflow waits on `condition()` for a signal, with a 15-minute timer as a fallback.
3. A reviewer decides. Impri POSTs a signed webhook to your receiver; deliveries go out on a 60-second tick.
4. The receiver checks the signature and signals the workflow with the action ID.
5. The workflow reads the verdict from `GET /v1/actions/:id`, sends the approved text with any edits, and reports the result.

The signal is only a wake-up call. The verdict always comes from Impri's API with your key, so a forged or replayed request to the receiver can't approve anything. That's also why the unsigned `workflow_id` in the query string is safe: a workflow only reacts to its own action ID, and only by re-reading Impri.

---

## Activities

```ts
// activities.ts
const BASE = process.env.IMPRI_BASE_URL ?? "https://api.impri.dev";
const headers = {
  Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
  "Content-Type": "application/json",
};

export interface ImpriAction {
  id: string;
  status: "pending" | "approved" | "rejected" | "expired" | "executed" | "execute_failed";
  decision?: { verdict: "approve" | "reject"; final_preview?: { body: string } };
}

export async function requestApproval(
  title: string,
  draft: string,
  workflowId: string,
  idempotencyKey: string,
): Promise<string> {
  const res = await fetch(`${BASE}/v1/actions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "email.send",
      title,
      preview: { format: "markdown", body: draft },
      editable: ["preview.body"],
      expires_in: 86400, // 24 h, then the card expires and the webhook fires
      idempotency_key: idempotencyKey, // a retried activity gets the same card back
      callback_url: `${process.env.WEBHOOK_URL}?workflow_id=${encodeURIComponent(workflowId)}`,
    }),
  });
  if (!res.ok) throw new Error(`Impri create failed: ${res.status}`);
  return (await res.json()).id;
}

export async function getAction(id: string): Promise<ImpriAction> {
  const res = await fetch(`${BASE}/v1/actions/${id}`, { headers });
  if (!res.ok) throw new Error(`Impri fetch failed: ${res.status}`);
  return res.json();
}

export async function reportResult(id: string, status: "executed" | "execute_failed") {
  const res = await fetch(`${BASE}/v1/actions/${id}/result`, {
    method: "POST",
    headers,
    body: JSON.stringify({ status }),
  });
  // 409: the result is already recorded (this is a retry after a lost response)
  if (!res.ok && res.status !== 409) throw new Error(`Impri result failed: ${res.status}`);
}

export async function sendEmail(body: string): Promise<void> {
  // your side effect: the only code path that sends
}
```

## Workflow

```ts
// workflows.ts
import { condition, defineSignal, proxyActivities, setHandler, workflowInfo } from "@temporalio/workflow";
import type * as activities from "./activities";

const { requestApproval, getAction, reportResult } = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 seconds",
});
const { sendEmail } = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 3 },
});

export const impriDecided = defineSignal<[string]>("impriDecided");

export async function refundEmailWorkflow(title: string, draft: string): Promise<string> {
  const { workflowId, runId } = workflowInfo();
  const actionId = await requestApproval(title, draft, workflowId, `${workflowId}:${runId}`);

  let woken = false;
  setHandler(impriDecided, (id) => {
    if (id === actionId) woken = true;
  });

  let action = await getAction(actionId);
  while (action.status === "pending") {
    // The webhook wakes us within about a minute; the timer covers a lost delivery.
    await condition(() => woken, "15 minutes");
    woken = false;
    action = await getAction(actionId); // the verdict comes from Impri, not the signal
  }

  if (action.status !== "approved") return action.status; // rejected | expired

  try {
    await sendEmail(action.decision!.final_preview!.body); // includes reviewer edits
  } catch (err) {
    await reportResult(actionId, "execute_failed");
    throw err;
  }
  await reportResult(actionId, "executed");
  return "executed";
}
```

## Webhook receiver

```ts
// webhook.ts: receives Impri's decision callback and wakes the workflow
import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Client, Connection, WorkflowNotFoundError } from "@temporalio/client";
import { impriDecided } from "./workflows";

const SECRET = process.env.IMPRI_WEBHOOK_SECRET!; // webhook_secret from GET /v1/project

function signedByImpri(raw: string, h: http.IncomingHttpHeaders): boolean {
  const ts = String(h["x-impri-timestamp"] ?? "");
  const nonce = String(h["x-impri-nonce"] ?? "");
  const sig = String(h["x-impri-signature"] ?? "");
  if (!(Math.abs(Date.now() / 1000 - Number(ts)) <= 300)) return false; // stale or missing
  const expected = "sha256=" + createHmac("sha256", SECRET).update(`${ts}.${nonce}.${raw}`).digest("hex");
  return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

const client = new Client({
  connection: await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233" }),
});

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const workflowId = url.searchParams.get("workflow_id");
    if (req.method !== "POST" || !workflowId) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");

    if (!signedByImpri(raw, req.headers)) {
      res.writeHead(401).end();
      return;
    }
    try {
      await client.workflow.getHandle(workflowId).signal(impriDecided, JSON.parse(raw).action_id);
    } catch (err) {
      if (!(err instanceof WorkflowNotFoundError)) {
        res.writeHead(503).end(); // Impri retries: 1 min, 5 min, 25 min, 2 h, 12 h
        return;
      }
    }
    res.writeHead(200).end();
  })
  .listen(Number(process.env.PORT ?? 8080));
```

`IMPRI_WEBHOOK_SECRET` is the project's `webhook_secret` from `GET /v1/project` (admin key); `POST /v1/project/rotate-webhook-secret` replaces it. The receiver must be reachable from Impri over public http(s): Impri doesn't deliver to private addresses unless a self-hosted server sets `IMPRI_ALLOW_PRIVATE_TARGETS=1`.

---

## What we ran

On 2026-11-16, the code above, unchanged, with a test worker (`TestWorkflowEnvironment.createLocal()`) and an Impri server built from the open-source repo:

- **Approve with an edit:** the webhook woke the workflow within a minute of the decision (15 and 51 seconds in two runs). The edited text was sent and the card ended `executed`.
- **Reject:** the workflow returned `rejected`; nothing was sent.
- **The send fails three times:** the card ended `execute_failed` and the workflow failed.
- **Same idempotency key twice:** both calls returned the same action ID.
- **Result reported twice:** Impri answered 409 to the second call and the activity treated it as done.
- **Webhook after the workflow finished:** 200, so Impri stops retrying. Unsigned request: 401.

Not exercised: the 15-minute fallback and the 24-hour expiry.

---

## Details that matter in production

- **One idempotency key per run.** Temporal retries a failed activity. If Impri created the card but the response got lost, the retry would create a second card; with `idempotency_key` it gets the first one back. Impri matches the key against every earlier action in the project, so a reused workflow ID needs the run ID in the key.
- **Expiry ends the loop.** `expires_in` takes 300 seconds to 30 days (default 72 hours). When it lapses, the card turns `expired`, the webhook fires and the workflow returns `expired`.
- **Send the edited text.** Use `decision.final_preview.body` from the API, not your draft.
- **The send itself can run twice.** If a worker dies mid-call, Temporal runs the activity again. Pass the Impri action ID to your email provider as its idempotency key if a duplicate matters.
- **Reporting the result is safe to retry.** Impri answers 409 once a result is recorded. Without the 409 check, a retry after a lost response would fail forever under Temporal's default retry policy, which has no attempt limit.
- **Rate limit.** Creating cards is limited to 60 requests per minute per API key.
- **The gate holds only if it's the only path.** A second send tool outside this workflow skips the approval.

---

## No public URL?

Leave out `callback_url`, the receiver and the signal, and shorten the timer to a minute: the loop then polls `GET /v1/actions/:id`. That's fine for a few waiting workflows; with many, the webhook saves a request per workflow per minute.

---

## Next step

Create a free project on [Impri Cloud](https://app.impri.dev/?signup=1): the key you get is the project's admin key, so it can create cards and read the `webhook_secret`. Start one workflow and the card appears in your inbox. Prefer your own infrastructure? [Self-hosting](self-hosting.md) runs the same API with Docker Compose. The request and decision fields are explained in [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md), and the webhook format in [webhooks](webhooks.md).
