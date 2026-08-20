# The Propose, Approve, Execute Pattern for AI Agents

Propose, approve, execute splits every risky agent action into three phases so a human decision — not a prompt instruction — is what actually gates the side effect.

---

## The three phases

**Propose.** The agent describes what it wants to do and hands that description to a store outside its own process — it does not perform the action yet. **Approve.** A human reviews the proposal and returns a decision: approved, rejected, or (implicitly, via a timeout) expired. **Execute.** Only on `approved` does the agent's code reach the function that actually sends the email, writes the row, or calls the paid API — and it reports back whether that execution succeeded.

The pattern only works if these three phases are enforced structurally, not just described in a prompt. If "propose" and "execute" are the same function call with a "please confirm first" instruction wrapped around it, an LLM can still talk itself into skipping the confirmation — there's no external state forcing the pause. The pattern requires the execute code path to be *literally unreachable* without a value that came from outside the agent's own reasoning.

```
 ┌──────────┐      1. propose       ┌───────────┐     2. approve/reject   ┌───────┐
 │  Agent   │ ─────────────────────▶│   Store    │◀───────────────────────│ Human │
 │          │                       │ (pending)  │                        │       │
 │          │◀──────────────────────│  decision  │
 │          │   3. poll / await     └───────────┘
 │          │
 │          │   4. execute (only if approved)
 │          │───────────────────▶  real side effect
 └──────────┘
```

## Implementing it with Impri

Impri implements exactly these three phases as three API calls. Here's the pattern applied to a marketing agent that wants to post to a company's social account, written in TypeScript against the Impri SDK:

```typescript
import { ImpriClient } from "@impri/sdk";

const impri = new ImpriClient({ apiKey: process.env.IMPRI_API_KEY! });

async function postWithApproval(draft: string, channel: string) {
  // 1. Propose — store the intent, no post happens yet
  const action = await impri.actions.create({
    kind: "social.post",
    title: `Post to ${channel}`,
    preview: { format: "markdown", body: draft },
    editable: ["preview.body"],
    expires_in: 21600, // 6 hours — stale marketing copy isn't worth posting
  });

  // 2. Approve — block until a human decides (polling happens under the hood)
  const decision = await impri.actions.awaitDecision(action.id, { timeoutS: 21600 });

  if (decision.status !== "approved") {
    console.log(`Not posting — status: ${decision.status}`);
    return { posted: false, status: decision.status };
  }

  // 3. Execute — only reachable here, using the human-approved (possibly edited) text
  const finalBody = decision.final_preview.body;
  const postResult = await socialApi.post(channel, finalBody);

  await impri.actions.reportResult(action.id, {
    status: "executed",
    payload: { post_url: postResult.url },
  });

  return { posted: true, url: postResult.url };
}
```

Three method calls, one per phase. Nothing about `socialApi.post` is reachable from inside the propose step — it lives strictly after the `decision.status !== "approved"` guard returns.

---

## Why the split matters more than the approval itself

A team that skips straight to "just ask for confirmation" usually ends up with one of two failure modes: the confirmation step gets silently dropped under refactoring because it's just a string in a prompt, or there's no record afterward of what was actually approved versus what the agent claims it asked about. Splitting propose/approve/execute into separate calls against an external store fixes both:

- The pending action is a real row somewhere, not a transient prompt turn — so there's an [audit log](audit-log.md) of every decision by construction, not as an add-on.
- The execute phase has a genuine dependency on the approve phase's return value. You cannot accidentally call `socialApi.post` without first having a `decision` object in scope with `status === "approved"`, because the code is structured that way.

## Where the pattern breaks down

The three-phase split gates the *call site* you wrap. It does not gate the underlying credential. If the agent (or a tool it has access to) can still call `socialApi.post` directly — because it holds the raw API token somewhere else in its toolset — the pattern is cosmetic. Apply propose/approve/execute at the layer where the credential itself lives, typically inside an SDK wrapper or MCP tool the agent has no way to bypass. See [AI agent guardrails for real-world actions](ai-agent-guardrails-for-real-world-actions.md) for the broader argument about chokepoints versus advisory checks.

The pattern also isn't a workflow engine. It doesn't branch, schedule, or sequence — it holds one decision per action. If your agent needs to propose five dependent actions and only proceed if all five are approved, that orchestration logic is yours to write; Impri is the primitive each individual gate is built from, not the coordinator across them.

## Next step

The [quickstart](quickstart.md) gets you an API key in a couple of minutes. If you're wiring this into an MCP-based agent instead of calling the REST API directly, [the MCP doc](mcp.md) shows the same three phases as three tool calls.
