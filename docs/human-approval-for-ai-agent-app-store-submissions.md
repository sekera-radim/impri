# Human Approval for AI Agent App Store and Play Store Submissions

Add human approval for AI agent App Store and Play Store submissions: a release checklist a person signs off on before your agent submits a build for review.

Handing an agent your release pipeline is tempting: it can bump versions, write release notes and push a build. But a store submission is public, slow to undo and sometimes irreversible, so a human should own the final "submit". This page shows a TypeScript pattern for that one decision.

---

## Why submission is the step to gate

Building and uploading to TestFlight or an internal track is low risk. Pressing "submit for review" or promoting to production is not:

- Review queues are slow, so a bad submission costs days, not minutes.
- Release notes and store metadata go public and are hard to retract.
- A rejected or flagged build can hurt the app's standing, and a wrong build going live reaches real users.
- Staged rollouts and pricing or availability changes are commercial decisions, not engineering ones.

Let the agent do everything up to the store boundary. Gate only the last step.

---

## What the reviewer should see

An approval card is only useful if it answers "is this ready?" at a glance. Put the facts in the markdown preview:

```
**App:** Acme Field Tool (iOS)
**Version:** 4.2.0 (build 1187)
**Track:** Production, 10% staged rollout
**Changes since last release:** 14 commits, 3 merged PRs
**CI:** all checks green (link)
**Release notes:**
> Faster sync, fixed crash when offline...
```

Mark `preview.body` as `editable` so the reviewer can fix a typo in the release notes and approve in one motion. The agent then submits with the edited text.

---

## TypeScript example

Node 18+ with built-in `fetch`. `submitToStore` is your own function (fastlane, the store APIs, a CI trigger) — Impri never talks to the stores.

```typescript
const API = "https://api.impri.dev";
const headers = {
  Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
  "Content-Type": "application/json",
};

interface Release {
  app: string;
  version: string;
  build: number;
  track: string;
  ciUrl: string;
  notes: string;
}

async function requestSubmissionApproval(r: Release): Promise<string> {
  const res = await fetch(`${API}/v1/actions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "store.submit",
      title: `Submit ${r.app} ${r.version} (${r.build}) to ${r.track}`,
      preview: {
        format: "markdown",
        body: `**CI:** ${r.ciUrl}\n\n**Release notes:**\n\n${r.notes}`,
      },
      expires_in: 14400, // 4 hours: an old approval should not ship a newer build
      editable: ["preview.body"],
      idempotent: false,
      undo: "Remove the build from review or halt the rollout in the store console.",
    }),
  });
  if (!res.ok) throw new Error(`Impri push failed: ${res.status}`);
  return (await res.json()).id;
}

async function waitForDecision(id: string) {
  for (;;) {
    const res = await fetch(`${API}/v1/actions/${id}`, { headers });
    const action = await res.json();
    if (action.status !== "pending") return action;
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
}

const id = await requestSubmissionApproval(release);
const decision = await waitForDecision(id);

if (decision.status === "approved") {
  const notes = decision.decision.final_preview.body; // includes human edits
  const state = await submitToStore(release, notes)
    .then(() => "executed")
    .catch(() => "execute_failed");
  await fetch(`${API}/v1/actions/${id}/result`, {
    method: "POST",
    headers,
    body: JSON.stringify({ status: state }),
  });
}
```

The `idempotent: false` flag puts a warning badge on the card, which is correct: submitting twice can create duplicate review requests. The four-hour expiry is deliberate — if nobody approves before the next commit lands, the approval no longer describes the build you would ship.

---

## Boundaries worth stating plainly

- **Impri does not know what a build is.** It shows text and holds a decision. Make sure the version and build number in the card are the ones `submitToStore` actually uploads, ideally by passing the same `release` object to both.
- **It is only a gate if it is the only path.** If the agent's CI has store credentials in its environment and can run `fastlane deliver` on its own, it can bypass the approval. Keep store credentials in the gated step only.
- **It is not a release pipeline.** Build orchestration, rollout percentages and rollback automation belong in your CI. Impri answers one question: did a human approve this submission?

---

## Wiring it into how you release

Send the card to wherever your team decides: [Slack](slack-approval.md) works well for a release channel, and the [audit log](audit-log.md) keeps a record of who approved which version. If you write the agent with an SDK, the [TypeScript SDK](sdk-typescript.md) wraps these calls.

---

## Next step

Start with the [quickstart](quickstart.md) to get an API key, then gate just the submit call. If your agent runs in Claude Code or another MCP client, use the [MCP server](mcp.md) instead of writing the HTTP calls yourself.
