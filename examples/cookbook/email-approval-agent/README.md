# Recipe 1 — Email Approval Agent

An agent drafts an outbound email, gates the send on human approval, and
honors any reviewer edits before actually sending.

## Why this matters

Autonomous email senders can cause embarrassing or legally significant
mistakes. Putting a human in the loop — even just for high-stakes or
bulk messages — lets you move fast without the risk.

## How it works

```
agent drafts email
    → POST /v1/actions  (kind: email.send, editable: [preview.body])
    → human sees draft in inbox, edits/approves/rejects
    → agent polls GET /v1/actions/:id
    → if approved: send using decision.final_preview.body
    → POST /v1/actions/:id/result (executed | execute_failed)
```

The key detail: always send `decision.final_preview.body`, not the original
draft. When the reviewer edits the body, `final_preview` carries the
corrected version and `decision.diff` is set.

## Requirements

- Node 18+ (no npm install — uses global `fetch`)
- An Impri API key with `actions` scope
- A running Impri (self-hosted or cloud)

## Quick start

```bash
# Self-hosted
IMPRI_API_KEY=im_your_key node agent.mjs

# Cloud
IMPRI_API_KEY=im_your_key IMPRI_BASE_URL=https://api.impri.dev node agent.mjs
```

Open your Impri inbox, approve the card (optionally edit the draft), and
watch the agent send.

## Adapting to your use case

Replace `sendEmail()` with your real sender:

```js
import { Resend } from 'resend';
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendEmail(to, subject, bodyMarkdown) {
  const { id } = await resend.emails.send({
    from: 'agent@yourcompany.com',
    to,
    subject,
    text: bodyMarkdown,
  });
  return id;
}
```

The rest of the loop (`POST /actions`, poll, `POST /result`) stays the same.

## Idempotency

The script uses `idempotency_key: "email-q3-proposal-alice@example.com"`.
If your agent crashes and restarts, re-posting with the same key returns the
existing action rather than creating a duplicate — so the reviewer only sees
one card per email.
