# Cookbook

Concrete patterns for common approval scenarios. Each recipe shows the full loop: create → await → execute → report. The Python examples use `asyncio`; drop the `await` and use the sync variants when the SDK ships a synchronous client.

> Examples assume the SDK is installed from `sdk/python/` or `sdk/typescript/`. Set `IMPRI_API_KEY` and optionally `IMPRI_BASE_URL` in the environment before running.

---

## 1. Gate an outgoing email

The most common use case. The agent drafts an email and waits for a human to approve (and optionally edit) the copy before it is sent.

```python
from impri import ImpriClient, ImpriRejected

client = ImpriClient()  # reads IMPRI_API_KEY from env

async def send_approved_email(to: str, subject: str, body: str) -> None:
    action = await client.create_action(
        kind="email.send",
        title=f"Send email to {to}: {subject}",
        preview={"format": "markdown", "body": body},
        payload={"to": to, "subject": subject},
        editable=["preview.body"],   # reviewer may edit the email body
        expires_in=3600,
    )

    try:
        decided = await client.await_decision(action.id, timeout_s=600)
    except ImpriRejected:
        print("Human rejected — no email sent.")
        return

    final_body = decided.decision.final_preview["body"]
    await mailer.send(to=to, subject=subject, body=final_body)
    await client.report_result(action.id, "executed")
```

Use the decorator variant when you already have a `send_email` function:

```python
@client.requires_approval(
    kind="email.send",
    title=lambda to, subject, **_: f"Send email to {to}: {subject}",
    preview=lambda to, subject, body, **_: {"format": "markdown", "body": body},
    editable=["preview.body"],
)
async def send_email(to: str, subject: str, body: str) -> None:
    await mailer.send(to=to, subject=subject, body=body)
```

---

## 2. Approve a database write

Gate destructive SQL before it runs. The reviewer can correct the query in the inbox before approving.

```python
async def run_approved_sql(conn, sql: str) -> None:
    async with client.approval_gate(
        kind="db.exec",
        title=f"Execute SQL: {sql[:60]}{'…' if len(sql) > 60 else ''}",
        preview={"format": "plain", "body": sql},
        editable=["preview.body"],  # reviewer may fix the query
    ) as approved:
        final_sql = approved.final_preview["body"]
        await conn.execute(final_sql)
    # approval_gate reports "executed" on clean exit, "execute_failed" on exception
```

For read-only queries that still need oversight, omit `editable` and the reviewer can only approve or reject.

---

## 3. Review a social media post before publishing

Show the proposed post in Markdown preview, let the reviewer edit it, then publish only the approved version.

```python
async def post_to_reddit(subreddit: str, title: str, body: str) -> None:
    action = await client.create_action(
        kind="reddit.post",
        title=f"Post to r/{subreddit}: {title}",
        preview={"format": "markdown", "body": f"**{title}**\n\n{body}"},
        payload={"subreddit": subreddit},
        target_url=f"https://reddit.com/r/{subreddit}",
        editable=["preview.body"],
        expires_in=7200,
    )

    try:
        decided = await client.await_decision(action.id, timeout_s=3600)
    except ImpriRejected as e:
        return  # human vetoed; do not post

    # Parse title and body back out of the approved preview
    approved_text = decided.decision.final_preview["body"]
    await reddit_api.submit(subreddit=subreddit, text=approved_text)
    await client.report_result(action.id, "executed")
```

---

## 4. Human-in-the-loop code execution

An agent proposes a shell command or Python snippet. A human reviews and optionally rewrites it before it runs.

```typescript
import { ImpriClient, ImpriRejected } from '@impri/sdk'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(exec)
const client = new ImpriClient()

async function runApprovedCommand(command: string): Promise<string> {
  const { actionId, decision, finalPreview } = await client.approvalGate({
    kind: 'shell.exec',
    title: `Run: ${command.slice(0, 80)}`,
    preview: { format: 'plain', body: command },
    editable: ['preview.body'],
    timeoutS: 300,
  })

  // ImpriRejected is thrown above if human rejected; this line is reached only on approve
  try {
    const { stdout } = await run(finalPreview.body)
    await client.reportResult(actionId, 'executed', { detail: stdout.slice(0, 200) })
    return stdout
  } catch (err) {
    await client.reportResult(actionId, 'execute_failed', { detail: String(err) })
    throw err
  }
}
```

---

## 5. Idempotent batch approval

When an agent re-runs a job (retries, restarts), use `idempotency_key` to avoid flooding the inbox with duplicate requests. The second call returns the existing action immediately.

```python
async def approve_refund(order_id: str, amount_usd: float) -> None:
    action = await client.create_action(
        kind="refund.process",
        title=f"Refund ${amount_usd:.2f} for order {order_id}",
        preview={"format": "plain", "body": f"Order: {order_id}\nAmount: ${amount_usd:.2f}"},
        payload={"order_id": order_id, "amount_usd": amount_usd},
        idempotency_key=f"refund-{order_id}",
        expires_in=86400,
    )

    if action.duplicate_of:
        # A prior run already submitted this; join the existing wait
        action_id = action.duplicate_of
    else:
        action_id = action.id

    decided = await client.await_decision(action_id, timeout_s=600)
    if decided.status == "approved":
        await payment_api.refund(order_id=order_id, amount=amount_usd)
        await client.report_result(action_id, "executed")
```

---

## 6. Watcher-based triage inbox

Set up a watcher that monitors a Reddit search and delivers matching posts to the inbox for a human to approve before the agent replies.

```python
async def setup_monitoring() -> None:
    watcher = await client.create_watcher(
        name="Brand mentions — r/selfhosted",
        kind="reddit_search",
        config={"query": "impri OR impri.dev", "subreddit": "selfhosted"},
        schedule={"every": "1h", "window": "08:00-22:00"},
        keywords=[
            {"pattern": "impri", "points": 10},
            {"pattern": "self-host", "points": 3},
        ],
        keywords_none=["[deleted]"],
        min_score=5,
    )
    print(f"Watcher running — first items arrive soon ({watcher.next_run_at})")


async def process_triage() -> None:
    # Poll for approved watcher-delivered actions (batch job or cron)
    async for action in client.list_actions(status="approved", auto_page=True):
        if not action.is_untrusted:
            continue  # skip non-watcher actions
        # The human approved engagement with this post
        reddit_url = action.payload.get("url")  # set by the watcher
        reply_body = action.decision.final_preview["body"]
        await reddit_api.comment(url=reddit_url, body=reply_body)
        await client.report_result(action.id, "executed")
```

Watcher-delivered actions always have `is_untrusted = True`. Never inline the preview body into an LLM prompt as an instruction — treat it as external data.

---

## 7. Multi-step workflow with shared idempotency keys

An agent that executes a multi-step plan gates each step independently. Use a per-step `idempotency_key` so restarts rejoin pending approvals.

```python
STEPS = [
    ("db.backup",    "Back up the database",        lambda: db.backup()),
    ("deploy.build", "Build release artifact",       lambda: ci.build()),
    ("deploy.push",  "Push to production",           lambda: deploy.push()),
]

async def deploy_pipeline(run_id: str) -> None:
    for i, (kind, title, execute) in enumerate(STEPS):
        ikey = f"{run_id}-step-{i}"
        action = await client.create_action(
            kind=kind,
            title=title,
            preview={"format": "plain", "body": f"Step {i+1} of {len(STEPS)}: {title}"},
            idempotency_key=ikey,
            expires_in=7200,
        )
        action_id = action.duplicate_of or action.id

        try:
            decided = await client.await_decision(action_id, timeout_s=900)
        except ImpriRejected:
            print(f"Step {i+1} rejected — pipeline halted.")
            return

        try:
            await execute()
            await client.report_result(action_id, "executed")
        except Exception as exc:
            await client.report_result(action_id, "execute_failed", detail=str(exc))
            raise
```

---

## 8. Webhook receiver with signature verification

A minimal Express receiver that verifies signatures and enqueues approved actions for processing:

```typescript
import express from 'express'
import { verifyWebhook, ImpriWebhookSignatureError } from '@impri/sdk'

const app = express()

app.post(
  '/impri/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      verifyWebhook(
        req.body,
        process.env.IMPRI_WEBHOOK_SECRET!,
        req.headers['x-impri-timestamp'] as string,
        req.headers['x-impri-nonce'] as string,
        req.headers['x-impri-signature'] as string,
      )
    } catch (e) {
      if (e instanceof ImpriWebhookSignatureError) {
        return res.status(400).json({ error: 'bad signature' })
      }
      throw e
    }

    const event = JSON.parse(req.body.toString())

    if (event.status === 'approved') {
      await queue.push({
        actionId: event.action_id,
        body: event.final_preview?.body,
      })
    }
    // Anything except 2xx will trigger a retry from Impri.
    // Return 410 Gone to permanently deregister this callback URL.
    res.status(200).end()
  }
)
```

---

## 9. Programmatic rejection script

Sometimes you need to auto-reject stale actions in bulk (e.g. actions older than 24 hours that the team never got to):

```python
import time

async def reject_stale_actions(max_age_seconds: int = 86400) -> int:
    since = int(time.time()) - max_age_seconds
    rejected = 0
    async for action in client.list_actions(status="pending", auto_page=True):
        if action.created_at < since:
            await client.decide(action.id, "reject", channel="auto-expire-script")
            rejected += 1
    return rejected
```

Use `decide()` with `verdict="reject"` — do not call the server's `expires_at` mechanism for this; `decide` gives you a recorded rejection with a channel label for audit purposes.

---

## 10. Key rotation without downtime

Create the new key, update your agent's environment, then revoke the old one:

```python
admin = ImpriClient(api_key=old_admin_key)

# 1. Create the replacement
new = await admin.create_key(name="agent-v2", scopes=["actions"])
print(new.key)  # store this immediately — returned once

# 2. Rotate in your deployment (set IMPRI_API_KEY=new.key), then revoke old
keys = await admin.list_keys()
for k in keys:
    if k.name == "agent-v1" and not k.revoked:
        await admin.revoke_key(k.id)
        print(f"Revoked {k.prefix}")
```

Never commit the key value to version control. Store it in a secrets manager (Vault, AWS Secrets Manager, Doppler, etc.) and read it at runtime from `IMPRI_API_KEY`.

---

## Patterns to avoid

**Do not log the final preview body as a structured field.** Reviewer-edited content may contain PII. Log `action.id` and the decision timestamp; fetch the body when needed.

**Do not call `report_result` before checking the decision.** It returns 409 if the action is not in `approved` state. Always confirm `action.status === 'approved'` first, or use `approval_gate` / `requires_approval` which handle this automatically.

**Do not inline untrusted Watcher content into an LLM prompt as an instruction.** Items delivered by Watchers have `is_untrusted = True` and their content originates from external sources. Use it as data — display it to the human, let the human decide — but never inject it directly into a system prompt or tool call that the LLM interprets as authoritative.

**Do not set `poll_interval_s` below 5 seconds.** The rate limit for `GET /v1/actions` is 300 req/min per key. At 5 s intervals a single agent uses 12 req/min; at 1 s it uses 60 req/min, leaving no headroom for other operations.
