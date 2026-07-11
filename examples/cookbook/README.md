# Impri Cookbook

Runnable, dependency-light recipes showing how to integrate Impri into real
agentic workflows. Each recipe is a standalone script with its own README.

All scripts target a running Impri instance. Set `IMPRI_API_KEY` to your key
(starts with `im_`) and optionally `IMPRI_BASE_URL` to point at a self-hosted
instance or `https://api.impri.dev` for the cloud.

See the [quickstart](../../docs/quickstart.md) to get Impri running in under
5 minutes with Docker Compose.

---

## Recipes

### 1. [email-approval-agent](./email-approval-agent/)

Gate an outbound email on human approval. The reviewer can edit the draft
before approving — the agent always sends the `decision.final_preview`, so
the human's edits are honored.

**Script:** `email-approval-agent/agent.mjs` (Node 18+, no npm install)
**Scope:** `actions`

```bash
IMPRI_API_KEY=im_xxx node email-approval-agent/agent.mjs
```

---

### 2. [reddit-reply-agent](./reddit-reply-agent/)

Propose a Reddit comment, gate the post on approval. The inbox card links
directly to the thread so the reviewer can read context before deciding.

**Script:** `reddit-reply-agent/agent.mjs` (Node 18+, no npm install)
**Scope:** `actions`

```bash
IMPRI_API_KEY=im_xxx node reddit-reply-agent/agent.mjs
```

---

### 3. [deploy-gate](./deploy-gate/)

Gate a production deployment on human sign-off. Shows how to include a
change summary and diff link, use idempotency keys for CI retries, and
fail the pipeline step when the reviewer rejects.

**Script:** `deploy-gate/agent.mjs` (Node 18+, no npm install)
**Scope:** `actions`

```bash
IMPRI_API_KEY=im_xxx GIT_SHA=a3f8c91 node deploy-gate/agent.mjs
```

---

### 4. [payment-approval](./payment-approval/)

Gate payments above a configurable dollar threshold. Low-value payments
auto-execute; high-value ones require explicit human approval. Written in
Python to show that any language works against the REST API.

**Script:** `payment-approval/agent.py` (Python 3.8+, stdlib only)
**Scope:** `actions`

```bash
IMPRI_API_KEY=im_xxx APPROVAL_THRESHOLD=100 python3 payment-approval/agent.py
```

---

### 5. [rss-watcher-to-inbox](./rss-watcher-to-inbox/)

Create an RSS watcher with keyword scoring rules and watch new matching
items land as pending triage actions in the inbox. Demonstrates the Watcher
half of the Impri API: `POST /v1/watchers`, schedule, deduplication, and
how to list/pause watchers.

**Script:** `rss-watcher-to-inbox/agent.mjs` (Node 18+, no npm install)
**Scope:** `watch` (+ `actions` to read the inbox)

```bash
IMPRI_API_KEY=im_xxx node rss-watcher-to-inbox/agent.mjs
```

---

## Common patterns

### The approval loop (all action recipes)

```
1. POST /v1/actions          — propose the action, get action.id
2. poll GET /v1/actions/:id  — wait for status != "pending"
3. if approved:
       use decision.final_preview (not the original draft)
       execute the real side effect
       POST /v1/actions/:id/result { status: "executed" }
4. if rejected / expired:
       do nothing; optionally POST result { status: "execute_failed" }
```

### Idempotency

Pass `idempotency_key` on every create call. A unique key per logical event
(email to alice, deploy of SHA abc123, payment of invoice INV-007) means
agent crashes and retries never create duplicate inbox cards or double
payments.

### Editable drafts

```js
{ editable: ["preview.body"] }
```

Lets the reviewer edit the draft text before approving. Always execute with
`decision.final_preview.body` — never the original — so human corrections
are honored.

### First-run baseline (watchers)

A newly created watcher always baselines on its first run: it records
existing feed items without creating inbox actions. New inbox actions
appear starting from the **second** run. This prevents flooding your inbox
with historical articles when you first add a feed.

### Key scopes

| Scope | Required for |
|---|---|
| `actions` | Submit, poll, and report actions (recipes 1–4) |
| `watch` | Create and manage watchers (recipe 5) |
| `admin` | Create keys, inspect project — implies all other scopes |

Create a scoped key with:

```bash
curl -X POST http://localhost:8484/v1/keys \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent", "scopes": ["actions", "watch"]}'
```
