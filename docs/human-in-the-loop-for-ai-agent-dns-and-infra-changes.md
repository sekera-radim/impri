# Human-in-the-Loop for AI Agent DNS and Infrastructure Changes

Human-in-the-loop for AI agent DNS and infrastructure changes: hold record edits, MX swaps and load balancer tweaks for a person to approve before they go live.

DNS is a strange target for an autonomous agent: a single record change can take down email, break TLS validation or redirect a whole domain, and caches mean you can't simply "undo" in seconds. If an agent proposes DNS or edge-infrastructure changes, a person should see the exact diff first. This page shows a TypeScript pattern for doing that.

---

## Why DNS changes are different from other writes

- **Slow to reverse.** Rolling back a record does not un-cache it. A bad change with a one-hour TTL is wrong for an hour, everywhere.
- **Blast radius is the whole domain.** An MX or NS mistake affects mail and every subdomain, not one customer.
- **Small diffs hide big risk.** Changing `10 mail.example.com.` to `10 mail.exampel.com.` looks harmless in a log line and is catastrophic in production.

That makes the human's job clear: read a precise before/after and confirm it. The agent's job is to compute that diff, not to decide it's fine.

---

## Example: propose a record change with a before/after diff

The agent reads the current record set from your DNS provider, builds the desired state, and pushes both into the preview. The reviewer sees the delta, and only on approval does your code call the provider.

```typescript
const BASE = "https://api.impri.dev";
const headers = {
  Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
  "Content-Type": "application/json",
};

interface RecordChange {
  zone: string;
  name: string;
  type: string;
  before: string;
  after: string;
  ttl: number;
}

async function proposeDnsChange(c: RecordChange): Promise<string> {
  const body = [
    `**Zone:** ${c.zone}`,
    `**Record:** ${c.name} ${c.type} (TTL ${c.ttl}s)`,
    "",
    "```diff",
    `- ${c.before}`,
    `+ ${c.after}`,
    "```",
  ].join("\n");

  const res = await fetch(`${BASE}/v1/actions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "dns.record_update",
      title: `${c.type} ${c.name}.${c.zone}: ${c.before} -> ${c.after}`,
      preview: { format: "markdown", body },
      expires_in: 3600,
      idempotent: true,
      undo: `Set ${c.name} ${c.type} back to ${c.before}; note the ${c.ttl}s TTL before caches expire`,
    }),
  });
  if (!res.ok) throw new Error(`push failed: ${res.status}`);
  return (await res.json()).id;
}

async function waitForDecision(id: string) {
  for (;;) {
    const res = await fetch(`${BASE}/v1/actions/${id}`, { headers });
    const action = await res.json();
    if (action.status !== "pending") return action;
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

const id = await proposeDnsChange({
  zone: "example.com",
  name: "www",
  type: "CNAME",
  before: "old-lb.example.net.",
  after: "new-lb.example.net.",
  ttl: 300,
});
const decision = await waitForDecision(id);

if (decision.status === "approved") {
  await dnsProvider.updateRecord(/* your provider call */);
  await fetch(`${BASE}/v1/actions/${id}/result`, {
    method: "POST",
    headers,
    body: JSON.stringify({ status: "executed" }),
  });
}
```

Here `dnsProvider` stands for whatever client you use (Cloudflare, Route 53, your registrar). Impri never talks to it.

---

## Practical tips

**Lower the TTL first, as its own approved action.** If a change is risky, propose "drop TTL to 60s" as one card and the actual change as a second. The reviewer approves the cheap, reversible step before the consequential one.

**One change per action.** A card titled "update 14 records" invites rubber-stamping. Keep each action small enough to read in ten seconds.

**Use `undo` honestly.** The optional `undo` text is shown on the card. Write down the real rollback, including the caching caveat, so the reviewer knows what they are signing up for.

**Match expiry to reality.** Planned changes usually have a window. An hour-long `expires_in` stops an approval from firing after the maintenance window closed.

---

## Boundaries

- **Impri is only the gate.** It stores the proposed change, notifies you and holds the decision. It does not check whether the record is valid, run a plan, or apply anything.
- **The gate holds only if the agent can't bypass it.** Keep the DNS API token in the wrapper that requires an approved decision, not in the agent's general toolset. If the agent can call the provider directly, it can route around the approval.
- **This is not infrastructure-as-code review.** For declarative stacks you may already use plan review; see [approving Terraform changes](human-approval-for-ai-agent-terraform-changes.md) for that shape. Impri fits the imperative, API-call style of change.

Approvals can arrive through [Telegram](telegram-approval.md) if you want to confirm a change from your phone during an incident, and the [audit log](audit-log.md) records who approved which change and when.

---

## Next step

Follow the [quickstart](quickstart.md) to get an API key, or use the [MCP server](mcp.md) if your agent runs in Claude Code or another MCP client. Impri is open-core, MIT-licensed and self-hostable.
