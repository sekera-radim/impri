# AI Agent Approval Workflow

An AI agent approval workflow pauses an agent right before a risky action so a person can approve, reject, or edit it before anything actually runs.

This page is the map: what the workflow looks like end to end, the decisions that shape one, and links to the specific use case closest to what your agent does.

---

## When you need one

Not every agent action needs a person in the loop. You need an approval workflow when an agent can trigger something hard to undo — sending a message, spending money, changing a record, shipping code — and the content or target of that action is generated rather than fixed. A read-only agent that only summarizes data doesn't need this. An agent that drafts a refund, a deploy, or an outbound email does, because a bad draft executed at machine speed is a bad draft that already happened. [What is human-in-the-loop for AI agents](what-is-human-in-the-loop-for-ai-agents.md) covers the underlying reasoning in more depth.

---

## How it looks in practice

The shape is always the same three steps, regardless of what the agent does:

1. **Propose.** The agent pushes the action it wants to take — a draft, a query, a request — with enough context for a human to judge it, instead of executing directly.
2. **Decide.** A person sees the proposal in an inbox and approves it, rejects it, or edits the draft first. Nothing runs until this happens.
3. **Execute.** The agent picks up the decision and only then performs the real side effect, using the human-approved (and possibly edited) version.

This is the propose → approve → execute pattern — see [the propose-approve-execute pattern](the-propose-approve-execute-pattern.md) for the mechanics and [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) for the three-call integration over REST or MCP.

```text
Agent                          Gate                            Human
  │                              │                                │
  ├── propose action ───────────▶ stores it, notifies ──────────▶ inbox card
  │                              │                                │
  │                              │◀── approve / reject / edit ────┤
  ├── read decision ─────────────┤                                │
  │                              │                                │
  └── execute (only if approved) │                                │
```

---

## Decision points that shape a workflow

Four choices turn the generic pattern above into a workflow that fits your agent:

- **What to gate.** Gate the actions that are hard to reverse or costly to get wrong — sends, spend, deploys, deletes — not everything the agent does. Gating read-only or fully reversible steps just adds latency for no safety gain.
- **Timeouts and expiry.** A pending decision shouldn't wait forever, and an approved-too-late decision shouldn't execute against stale context. See [handling approval timeouts and expiry in agents](handling-approval-timeouts-and-expiry-in-agents.md) for how long to set an action's expiry per kind of action.
- **Escalation and auto-decisions.** Not every action needs a human every time. A rules engine can auto-approve low-stakes matches, auto-reject known-bad patterns, or route specific kinds to a named channel, so people only see what actually needs judgment — see [the rules engine](rules.md).
- **Audit trail.** Once a decision is made, who made it and when needs to be recorded somewhere nobody can quietly edit afterward — see [building an audit trail for AI agent actions](audit-trail-for-ai-agent-actions.md).

---

## Approval workflows by use case

The pattern above is the same everywhere; what changes is what gets gated and what the reviewer needs to see. Pick the page closest to your agent:

**Coding and infrastructure**
- [Approve AI agent GitHub Actions workflows](approve-ai-agent-github-actions-workflows.md) — gate a workflow file or dispatch an agent proposes before it runs in CI.
- [Human-in-the-loop CI/CD for AI agents](human-in-the-loop-ci-cd-ai-agents.md) — the broader pattern for gating build and deploy steps an agent triggers.
- [Human-in-the-loop for AI agent DNS and infra changes](human-in-the-loop-for-ai-agent-dns-and-infra-changes.md) — approval before an agent touches DNS records or infrastructure config.
- [Gate destructive database operations from an AI agent](approve-database-writes-from-an-ai-agent.md) — a human sees the actual statement before a write or schema change touches production.
- [Get human approval into your coding agent](how-to-get-human-approval-into-your-coding-agent.md) — wiring the gate into Claude Code, Cursor, Codex, or Windsurf specifically.

**Communication and content**
- [Human approval for AI social media management](human-approval-for-ai-social-media-management.md) — review a post before it goes out under your account.
- [Approve AI-generated content before it publishes](approve-ai-generated-content-before-publishing.md) — the same gate applied to blog posts, docs, and marketing copy.
- [Human-in-the-loop for AI customer support](human-in-the-loop-ai-customer-support.md) — approve a support reply before it reaches a real customer.

**Money and operations**
- [Approval workflow for AI marketing automation](approval-workflow-for-ai-marketing-automation.md) — sign-off on a campaign or ad spend change before it goes live.
- [Approve AI agent payments and charges](approve-ai-agent-payments-and-charges.md) — a human confirms the amount and recipient before money moves.
- [Human-in-the-loop for AI agent incident response](human-in-the-loop-for-ai-agent-incident-response.md) — approval on the remediation step an agent proposes during an incident, not on the diagnosis.

**Background reading**
- [Human-in-the-loop, explained](human-in-the-loop-explained.md) — the concept without the implementation details.
- [HITL tools for LLM agents, compared](hitl-tools-for-llm-agents-compared.md) — how a dedicated approval gate differs from a workflow engine or a Slack bot you'd build yourself.

---

## How Impri implements this

Impri is the gate in the middle of that diagram, not the agent and not the execution step. An agent calls `POST /v1/actions` with a preview of what it wants to do; a human sees a card in a web, Slack, Discord, or Telegram inbox and approves, rejects, or edits it; the agent polls or receives a webhook and executes only on approval, then reports the outcome back. [Rules](rules.md) can auto-decide routine matches before a human ever sees them, and every step — created, rule-applied, decided, executed — lands in an append-only [audit log](audit-log.md). Impri never executes the action itself and doesn't judge whether a decision was the right call; it holds the queue and the record. Start with [quickstart](quickstart.md) for an API key, or [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) for the full integration.
