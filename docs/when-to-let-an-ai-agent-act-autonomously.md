# When to Let an AI Agent Act Autonomously (and When Not To)

Not every action an AI agent takes deserves a human in the loop — gating everything just trains reviewers to click approve without reading. This is the decision framework for picking which actions need a person and which don't.

---

## The wrong question

"Do I trust this agent?" is the wrong question, because trust isn't binary and it doesn't transfer between actions. A coding agent you trust to run `npm test` is not automatically an agent you trust to run `npm publish`. The useful question is per-action: **what happens if this specific call is wrong, and can I tell before it does damage?**

Two variables do most of the work:

- **Reversibility** — can the effect be undone cheaply, or is it permanent the moment it fires (an email sent, a payment charged, a production deploy)?
- **Blast radius** — does a mistake affect only the agent's own sandbox, or does it reach other people, other systems, or money?

Low reversibility and wide blast radius is the combination that needs a human. Everything else is a spectrum.

---

## A worked example: a CI/CD agent

Take an agent that watches a repo, opens PRs to fix failing builds, and can merge and deploy. Here's how the same agent's actions split by risk:

| Action | Reversible? | Blast radius | Gate? |
|---|---|---|---|
| Run `npm test` locally | Yes, no side effects | None | No |
| Open a draft PR | Yes, delete/close anytime | Low (visible, unmerged) | No |
| Comment on an existing issue | Awkward but editable | Low-medium (public) | Optional |
| Merge to `main` | Hard — revert is a new commit, but history + CI already ran | Medium-high | Yes |
| Deploy to production | No — users hit the bad code immediately | High | Yes |
| Rotate a database credential | No — old credential invalidated instantly | High | Yes |

The pattern: read-only and locally-contained actions run free. Anything that changes shared state outside the agent's own sandbox gets a gate. This is the same logic behind why CI systems let any branch build automatically but require a click to deploy — the framework isn't new, it's just being applied to an agent instead of a pipeline.

---

## Implementing the gate

Once you've drawn the line, the mechanism is the same regardless of where you draw it: the agent proposes the action, a human decides, and the agent's execution code only runs after an approval comes back. Here's the merge-and-deploy step from the CI/CD agent above, using Impri as the gate:

```typescript
const BASE = "https://api.impri.dev";
const headers = {
  Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
  "Content-Type": "application/json",
};

async function proposeDeploy(prNumber: number, diffSummary: string) {
  const created = await fetch(`${BASE}/v1/actions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "deploy.production",
      title: `Deploy PR #${prNumber} to production`,
      preview: { format: "markdown", body: diffSummary },
      undo: "Roll back via `fly deploy --image <previous-image-tag>`",
      idempotent: false,
      expires_in: 3600, // stale deploy proposals aren't worth approving after an hour
    }),
  }).then((r) => r.json());

  let status = "pending";
  while (status === "pending") {
    await new Promise((r) => setTimeout(r, 10_000));
    const check = await fetch(`${BASE}/v1/actions/${created.id}`, { headers }).then((r) =>
      r.json()
    );
    status = check.status;
    if (status !== "pending" && status === "approved") {
      await runDeploy(prNumber); // the actual deploy call — only reachable from here
      await fetch(`${BASE}/v1/actions/${created.id}/result`, {
        method: "POST",
        headers,
        body: JSON.stringify({ status: "executed" }),
      });
    } else if (status !== "pending") {
      console.log(`Deploy not approved (${status}), stopping.`);
    }
  }
}
```

The `npm test` and draft-PR steps upstream of this don't call Impri at all — they run unattended, because a wrong test run or an unmerged PR costs nothing. Only the step with no cheap undo waits for a person.

---

## Where this breaks down

Drawing the line correctly requires the agent's untrusted paths to actually be closed off. If `proposeDeploy` runs on a machine that also holds a raw deploy credential the agent could call directly, gating one code path doesn't stop the agent from finding the other. The gate is only real when the wrapped call is the *only* path to the side effect — see [the integrations guide](integrations.md) for wrapping tool executors so the credential itself isn't reachable outside the approval flow.

The reversibility/blast-radius framework also assumes you can estimate both correctly. Agents that read from external, untrusted sources (a scraped page, an incoming email) before deciding what to propose introduce a third variable: whether the input itself can be trusted. That's a large enough topic on its own — see [trust boundaries for AI agents](trust-boundaries-for-ai-agents.md) for how to reason about it.

---

## Next step

If you're adding a gate to your first action, [the quickstart](quickstart.md) covers getting an API key and making your first `POST /v1/actions` call, and [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) walks the full push → poll → execute pattern end to end.
