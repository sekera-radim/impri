# Human Approval for Mastra AI Agents

Wire human approval into a Mastra AI agent's workflow by suspending the run and resuming it from an Impri decision, instead of blocking a live request.

---

## Mastra already has a suspend point — use it for the right thing

Mastra's workflow engine has a built-in `suspend()` / `resume()` mechanism: a step can pause mid-run and persist its state, and something later calls `resume` with new input to continue it. Most Mastra examples use this for asking the *user who's chatting* a follow-up question. That's a different problem from what this page covers: a background agent step that wants to send an email, publish a post, or hit a paid API, where the person who needs to say yes is not the one who typed the original prompt and may not be online right now.

For that case, `suspend()` is still the right primitive — but instead of resuming from a chat reply, you resume from an Impri decision that arrived by webhook, possibly hours later, from someone checking their approval inbox on their phone.

---

## The workflow: suspend, wait, resume

```javascript
import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";

const requestApproval = createStep({
  id: "request-approval",
  inputSchema: z.object({ draft: z.string(), subject: z.string() }),
  outputSchema: z.object({ approvedBody: z.string() }),
  execute: async ({ inputData, suspend, resumeData }) => {
    if (resumeData) {
      // We're resuming after Impri delivered a decision.
      if (resumeData.status !== "approved") {
        throw new Error(`Not sending — action was ${resumeData.status}`);
      }
      return { approvedBody: resumeData.finalBody };
    }

    const res = await fetch("https://api.impri.dev/v1/actions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        kind: "email.send",
        title: `Send: ${inputData.subject}`,
        preview: { format: "markdown", body: inputData.draft },
        expires_in: 259200,
        editable: ["preview.body"],
      }),
    });
    const action = await res.json();

    // Suspend the run; store the action id so the resume handler knows
    // which workflow instance this decision belongs to.
    await suspend({ actionId: action.id });
  },
});

const sendEmail = createStep({
  id: "send-email",
  inputSchema: z.object({ approvedBody: z.string() }),
  outputSchema: z.object({ sent: z.boolean() }),
  execute: async ({ inputData }) => {
    await mailer.send(inputData.approvedBody);
    return { sent: true };
  },
});

export const outreachWorkflow = createWorkflow({
  id: "outreach-with-approval",
  inputSchema: z.object({ draft: z.string(), subject: z.string() }),
  outputSchema: z.object({ sent: z.boolean() }),
})
  .then(requestApproval)
  .then(sendEmail)
  .commit();
```

---

## Resuming from Impri's side

Impri doesn't push webhooks into your workflow engine directly — you poll `GET /v1/actions/:id` or run your own poller, then call Mastra's resume API once the status leaves `pending`. A small poller (cron, queue consumer, whatever you already run) closes the loop:

```bash
# runs every minute against actions your workflows are waiting on
ACTION=$(curl -s https://api.impri.dev/v1/actions/$ACTION_ID \
  -H "Authorization: Bearer $IMPRI_API_KEY")
STATUS=$(echo "$ACTION" | jq -r .status)

if [ "$STATUS" != "pending" ]; then
  BODY=$(echo "$ACTION" | jq -r '.decision.final_preview.body // empty')
  curl -s -X POST "http://localhost:4111/api/workflows/outreach-with-approval/resume" \
    -H "Content-Type: application/json" \
    -d "{\"runId\": \"$RUN_ID\", \"stepId\": \"request-approval\", \"resumeData\": {\"status\": \"$STATUS\", \"finalBody\": $(echo "$BODY" | jq -Rs .)}}"
fi
```

You need a small mapping table (`action_id → run_id, step_id`) somewhere durable — a KV row or a database column — since Mastra's resume call needs to know which suspended run an incoming decision belongs to. That mapping is on you; Impri only tracks the action's own lifecycle.

---

## Why suspend beats a blocking `await` here

A naive version of this would just `await` the Impri polling loop inside a single long-running step, the way a simple script does. Inside a Mastra workflow that's a real cost: the step (and whatever process is running it) stays alive and billed for however long the approval takes — minutes, or, with a 72-hour default expiry, potentially days. `suspend()` persists the run and frees the worker; `resume()` picks up exactly where it left off once your poller sees a decision. It's the same three-call Impri pattern underneath, just split across two separate invocations instead of one blocking one.

---

## Boundaries

Impri stores the proposed email, notifies a human, and holds the decision — it has no idea what a Mastra workflow or a suspended step is, and it will not call your resume endpoint for you. The gate only holds if `mailer.send` is unreachable from anywhere except the `sendEmail` step that runs after an approved resume; if another step or a retry path can call `mailer.send` directly, that bypasses this entirely. See [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) for the underlying pattern, [webhooks](webhooks.md) if you'd rather push decisions into your poller than pull them, and the [quickstart](quickstart.md) to get an API key.
