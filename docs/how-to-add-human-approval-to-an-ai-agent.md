# How to Add Human Approval to an AI Agent

AI agents are good at drafting. They are bad at knowing when to stop and ask. This guide explains how to wire a human checkpoint into an agent so it can propose actions but never execute them without an explicit human decision.

---

## The problem

An agent that can send emails, post comments, publish content, or make API calls needs a gate. Without one, a prompt injection, a misread context, or simply a bad draft goes out immediately.

The naive solution — "just add a confirmation step in the prompt" — doesn't work reliably. The agent still has to be trusted to actually pause, and there is no audit record.

What you need instead is a pattern where the agent can only *propose* an action and must poll for an external decision before proceeding. The execution code is never reached without that decision.

---

## The push → approve → execute pattern

```
Agent                         Impri                          Human
  │                             │                              │
  ├── POST /v1/actions ─────────▶ stores action, notifies ────▶ inbox card
  │   (kind, title, preview,    │                              │
  │    payload, editable)       │                              ├── approves / rejects
  │                             │◀─────────────────────────────┘
  ├── GET /v1/actions/:id ──────▶ returns status + decision
  │   (polling until decided)   │
  │                             │
  ├── [if approved] execute     │
  │   with final_preview        │
  │                             │
  └── POST /v1/actions/:id/result (executed | execute_failed)
```

The key property: the agent never calls "send" without first seeing `status: "approved"` from the API. The gate is in the data, not in a prompt.

---

## Minimal integration — REST

Any HTTP client works. The agent needs three calls.

**1. Push the action:**

```bash
ACTION=$(curl -s -X POST https://api.impri.dev/v1/actions \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "kind": "email.send",
    "title": "Outreach: Acme Corp partnership proposal",
    "preview": {
      "format": "markdown",
      "body": "Hi Sarah,\n\nI came across your work on distributed systems and think there could be a strong fit with what we are building at..."
    },
    "target_url": "https://mail.google.com/mail/u/0/#drafts/abc123",
    "expires_in": 86400,
    "editable": ["preview.body"]
  }')

ACTION_ID=$(echo $ACTION | jq -r .id)
```

**2. Poll until decided:**

```bash
while true; do
  RESULT=$(curl -s https://api.impri.dev/v1/actions/$ACTION_ID \
    -H "Authorization: Bearer $IMPRI_API_KEY")
  STATUS=$(echo $RESULT | jq -r .status)

  if [ "$STATUS" != "pending" ]; then
    echo "Decision: $STATUS"
    break
  fi
  sleep 10
done
```

**3. Execute only on approval, then report:**

```bash
if [ "$STATUS" = "approved" ]; then
  # Use final_preview — it carries the human-edited version when editable fields were changed
  BODY=$(echo $RESULT | jq -r '.decision.final_preview.body')
  send_email "$BODY"  # your sending function

  curl -s -X POST https://api.impri.dev/v1/actions/$ACTION_ID/result \
    -H "Authorization: Bearer $IMPRI_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"status": "executed"}'
fi
```

A rejected or expired action is never executed — the polling loop exits and the execution block is never reached.

---

## Minimal integration — MCP

For agents running inside Claude Code, Claude Desktop, or any MCP client, the Impri MCP server wraps the REST calls into tool calls. The agent handles the flow without writing any HTTP code.

**Configure the MCP server** (add to your client's MCP config):

```json
{
  "mcpServers": {
    "impri": {
      "command": "npx",
      "args": ["@impri/mcp"],
      "env": {
        "IMPRI_API_KEY": "im_your_key_here"
      }
    }
  }
}
```

The `IMPRI_BASE_URL` defaults to `http://localhost:8484`. For the cloud API set it to `https://api.impri.dev`.

**The agent flow in natural language (as seen by the agent):**

```
1. impri_push_action(
     kind="blog.publish",
     title="Draft: 10 things I wish I knew about distributed tracing",
     preview={ format="markdown", body="..." },
     expires_in=7200,
     editable=["preview.body"]
   )

   → { action_id: "act_xyz", status: "pending", inbox_url: "..." }

2. impri_await_decision(action_id="act_xyz", timeout_s=3600)
   # Blocks for up to 1 hour. The tool polls every 5 seconds internally.

   → { status: "approved", preview: { body: "..." }, edited_by_human: true }

3. publish_post(content=decision.preview.body)  # your actual action

4. impri_report_result(action_id="act_xyz", status="executed")
```

If the decision is `rejected` or `expired`, `impri_await_decision` returns that status and the agent stops without publishing.

---

## What Impri provides, what it doesn't

Impri is focused on one thing: the approval gate. It stores the proposed action, notifies the human, and holds the decision. It does not generate content, does not interpret what the action does, and never executes anything itself.

This keeps the integration surface small and the responsibilities clear: your agent owns the logic of what to do; Impri owns the question of whether a human said yes.

**What Impri is not:**

- A workflow engine with branching, scheduling, or multi-step orchestration. If you need those, look at n8n, Temporal, or Inngest. You can use Impri as one step inside an n8n workflow.
- A content moderation service. It does not review the content itself — it surfaces it to a specific human who you trust to make that call.
- A multi-agent coordination layer. It is a human-in-the-loop gate, not an agent-to-agent handoff mechanism.

**When Impri is the right tool:**

| Situation | Use Impri |
|-----------|-----------|
| Agent proposes external action (send, post, publish, modify) | Yes |
| You want a one-tap approve/reject from your phone | Yes |
| You need an audit log of what was approved, when, by whom | Yes |
| You want the human to be able to edit the draft before approving | Yes |
| You need to branch on many conditions before deciding | Consider n8n HITL node instead |
| You need to coordinate multiple agents with dependencies | Use a workflow engine; Impri can be one node |

---

## Handling edits made by the human reviewer

When you set `editable: ["preview.body"]`, the human reviewer can modify the draft text before approving. The decision callback and the polling response both carry:

- `decision.final_preview` — the content as the human left it (use this to execute)
- `decision.diff` — a unified diff showing what changed (present only when something was actually modified)

Always send `final_preview.body` rather than the original `preview.body`. The API never includes the original in `final_preview` — the field always holds the version the human approved.

---

## Expiry and what to do about it

Every action has an expiry (`expires_in` in seconds, minimum 300, maximum 30 days, default 72 hours). After expiry the status becomes `expired` and the action cannot be approved.

This is intentional. A draft reply to a Reddit thread that is two days old is not worth sending. Expiry is a correctness feature, not just a cleanup mechanism.

In your agent, treat `expired` the same as `rejected` — do not execute and optionally create a new action if the task is still relevant.

---

## Security considerations

**Rate limit**: `POST /v1/actions` is rate-limited to 60 requests per minute per API key. An agent caught in a loop will be throttled.

**Prompt injection from external sources**: if your agent reads from RSS, web pages, or social media before constructing the action, those sources may contain adversarial instructions. Impri does not interpret action content — it presents it to you visually as a card. But you should still treat any external text as data, not instructions, in your agent's system prompt.

**Scopes**: use the minimum scope your key needs. A key used only for actions approval needs `actions` scope, not `admin`. Create separate keys for watchers (`watch` scope) if you use those.
