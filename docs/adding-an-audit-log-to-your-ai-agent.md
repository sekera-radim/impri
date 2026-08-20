# Adding an Audit Log to Your AI Agent

Add an audit log to your AI agent without building a logging layer yourself — route side effects through an approval gate and get an append-only trail of who approved what for free.

---

## The order these usually get built in — and why it backfires

Most teams build the agent first, ship it, and only add an audit trail after someone asks "who approved this" and the honest answer is "we don't actually know." At that point you're retrofitting logging into code paths that already assume nobody's watching, and the gap between when the agent shipped and when logging landed is exactly the window nobody can answer questions about.

The cheaper order is the other way around: if every side-effecting call already goes through an approval gate before the agent's own code runs it, the audit trail is a byproduct of that gate, not a separate system you build and maintain. This page is about wiring that in while you're still building the agent, not after.

---

## The three calls, and what each one contributes to the log

The push/poll/execute pattern that gates an action produces a log entry at each step without any extra code:

```ruby
require 'net/http'
require 'json'
require 'uri'

BASE = 'https://api.impri.dev'
HEADERS = { 'Authorization' => "Bearer #{ENV['IMPRI_API_KEY']}", 'Content-Type' => 'application/json' }

def push_wiki_edit(page_slug, diff_summary, new_body)
  uri = URI("#{BASE}/v1/actions")
  req = Net::HTTP::Post.new(uri, HEADERS)
  req.body = {
    kind: 'wiki.update',
    title: "Update internal wiki: #{page_slug}",
    preview: { format: 'markdown', body: "#{diff_summary}\n\n---\n\n#{new_body}" },
    idempotent: true, # re-applying the same page body is a safe overwrite
    undo: "Restore the previous revision of #{page_slug} from wiki history",
    expires_in: 259_200
  }.to_json
  res = Net::HTTP.start(uri.hostname, uri.port, use_ssl: true) { |http| http.request(req) }
  JSON.parse(res.body)['id']
end

def await_and_apply(action_id, page_slug)
  loop do
    uri = URI("#{BASE}/v1/actions/#{action_id}")
    req = Net::HTTP::Get.new(uri, HEADERS)
    res = Net::HTTP.start(uri.hostname, uri.port, use_ssl: true) { |http| http.request(req) }
    result = JSON.parse(res.body)
    break if result['status'] != 'pending'
    sleep 10
  end

  return unless result['status'] == 'approved'

  applied = apply_to_wiki(page_slug, result.dig('decision', 'final_preview', 'body'))

  uri = URI("#{BASE}/v1/actions/#{action_id}/result")
  req = Net::HTTP::Post.new(uri, HEADERS)
  req.body = { status: 'executed', payload: { page_slug: page_slug, revision: applied[:revision] } }.to_json
  Net::HTTP.start(uri.hostname, uri.port, use_ssl: true) { |http| http.request(req) }
end
```

Nothing here calls a logging library. `POST /v1/actions` writes `action.created`. The human's decision writes `action.approved` or `action.rejected` with the actual reviewer identity, not just an API key. The `POST .../result` call writes `action.executed` and attaches whatever receipt you pass in `payload`. Four events, zero log statements.

---

## Three fields that turn a bare log into a useful one

The append-only rows exist regardless of what you pass, but three optional fields decide whether reading them back later actually answers the question you'll have:

- **`idempotent`** — tells a future reader (or your own on-call self at 2 a.m.) whether the recorded action was safe to retry. Leaving it unset means every row is ambiguous on that point.
- **`undo`** — a plain-English rollback instruction attached to the row at creation time, not something you have to reconstruct from memory during an incident.
- **`result.payload`** on the `/result` call — a structured receipt (the page revision, the record ID, the message ID) that turns "the agent said it did something" into "here is proof of exactly what it did."

Skipping all three still gives you a working audit trail. Setting them is the difference between a log that says an action happened and one that tells you what to do about it.

---

## Reading the trail back for one agent

Once a few actions have gone through, `GET /v1/audit?entity_id=<action_id>` returns that action's full lifecycle in order — created, approved, executed — each with its actor and timestamp. See [audit log](audit-log.md) for the full event and field reference, and [build an audit trail for AI agent actions](audit-trail-for-ai-agent-actions.md) for querying and exporting across many actions at once (filtering by time range, streaming a CSV for a compliance review, and so on). This page is about wiring the log in from the start of a new agent; those two cover using it once data is flowing.

---

## What you get without extra work, and what you still have to add

| Comes free from routing through the gate | Still your responsibility |
|---|---|
| Who approved or rejected each action, by name where the decision came from a chat button | Deciding which of your agent's calls are risky enough to gate in the first place |
| Immutable created/approved/executed timeline per action | Structured receipts in `result.payload` — Impri doesn't know what "done" looks like for your integration |
| Project-scoped, admin-only read access to the log | Retention policy beyond the built-in `AUDIT_RETENTION_DAYS` setting, if you need something more granular |

---

## What this doesn't cover

The audit log records that an action happened and who signed off — it doesn't evaluate whether the approval itself was the right call, and it only covers actions that actually went through `POST /v1/actions`. If your agent keeps a second, ungated path to the same system (a raw API token it can call directly), that path leaves no trace here. The log is only as complete as the gate is the agent's one way to cause the side effect — see [the SDK integrations](integrations.md) for wrapping the executor so there's no second path around it.

## Getting started

If you haven't wired up the base push/poll/execute pattern yet, [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) covers the three calls end to end. Start with [quickstart](quickstart.md) to get an API key, cloud or self-hosted, then add the fields above as you build.
