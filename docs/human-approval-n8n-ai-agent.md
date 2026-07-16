# Human Approval for n8n AI Agent Workflows

Add human approval for n8n AI Agent workflows using Impri's REST API in stock HTTP Request and Wait nodes — no custom node, no code beyond one small Function block.

---

## Where the gate goes in the workflow

A typical setup: a **Zendesk Trigger** node fires on a new ticket, an **AI Agent** node (backed by whatever model you've wired into n8n) drafts a reply, and a final node would normally post that reply straight back to the customer. That last step is the one worth gating — everything upstream is just reasoning, nothing has left the building yet.

The fix isn't a second AI Agent node double-checking the first one's work. It's an external decision the workflow cannot proceed without: Impri holds the draft, a human taps approve or reject, and only the approved branch reaches the node that actually calls the Zendesk API.

---

## The node pattern

Five nodes cover the whole loop:

| Node | Purpose |
|------|---------|
| Code (JavaScript) | Builds the `POST /v1/actions` body from the AI Agent's output |
| HTTP Request | `POST /v1/actions` — pushes the draft, returns `id` and `inbox_url` |
| Wait | Pauses 10s before each poll |
| HTTP Request | `GET /v1/actions/:id` — checks status |
| IF | Branches on `status`: loop back to Wait if `pending`, continue if not |

Set `Authorization: Bearer im_<key>` once as an n8n **Header Auth** credential and reuse it on both HTTP Request nodes. A key scoped to `actions` only is enough — this workflow never needs `admin`.

## Building the request in a Code node

```javascript
// Code node, right after the AI Agent node
const ticket = $('Zendesk Trigger').item.json;
const draft = $input.item.json.output; // AI Agent node's text output

return {
  json: {
    kind: "zendesk.reply",
    title: `Reply: ${ticket.subject}`,
    preview: {
      format: "markdown",
      body: draft,
    },
    target_url: `https://yourcompany.zendesk.com/agent/tickets/${ticket.id}`,
    expires_in: 3600,
    editable: ["preview.body"],
  },
};
```

Point the next node's HTTP Request body at `{{ $json }}` from this Code node — no manual JSON-building in the HTTP node itself.

## The polling loop, n8n-style

n8n has no built-in "poll until done" node, so you build the loop with a back-edge: **Wait (10s)** → **HTTP Request (GET status)** → **IF** `{{ $json.status === "pending" }}` → true branch connects back to the Wait node, false branch continues downstream. This is the same shape as `docs/integrations.md`'s n8n section, just spelled out node-by-node.

For a support-ticket workflow, keep `expires_in` short (an hour, as above) — a canned reply that's a day late has usually been overtaken by a human agent replying directly in Zendesk anyway.

## Reading the decision

Once the IF node's false branch fires, the last GET response carries the decision:

```json
{
  "status": "approved",
  "decision": {
    "verdict": "approve",
    "final_preview": { "format": "markdown", "body": "Edited reply text..." },
    "diff": "- original line\n+ edited line"
  }
}
```

Route on `status`: only the `approved` path reaches the Zendesk "post reply" node, and it must read `decision.final_preview.body`, never the Code node's original `draft` — the reviewer may have tightened the wording before approving.

## Skipping the loop with a webhook

Polling every 10 seconds is fine for low-volume ticket queues, but if your n8n instance has a public URL, set `callback_url` in the Code node's JSON to an n8n Webhook node's URL instead. Impri POSTs the decision there the moment a human decides, and you can replace the whole Wait/GET/IF loop with a single Webhook trigger that starts a second workflow. Signature verification for that payload is documented in [webhooks.md](webhooks.md).

## What this doesn't replace

Impri is the approval gate, not the workflow engine — n8n still owns branching, retries, and scheduling. Impri doesn't read the ticket or judge whether the reply is good; it shows the draft to a human and records what they decided. And the gate only holds if the Zendesk API credential lives on the "post reply" node and nowhere else in the workflow — if an earlier node also holds that credential, the AI Agent's output could reach Zendesk through a path that never touches Impri at all.

## Next step

Start from [Quickstart](quickstart.md) to get a key and push your first action, or see the accurate n8n reference pattern in [Integrations](integrations.md).
