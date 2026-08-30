# Why AI Agents Need Approval Gates

An agent that can act can act on a bad premise — approval gates are what stops a wrong draft from becoming a wrong action taken in the real world.

---

## The gap between "can generate" and "should execute"

Language models are good at producing a plausible next action: a reply, a database write, an API call, a payment. They are not good at knowing when the input they reasoned from was wrong — a hallucinated fact, a poisoned instruction buried in a scraped web page, a misread of ambiguous intent. Generation and judgment are different capabilities, and current agents have plenty of the first and unreliable amounts of the second.

As long as the output is text a person reads before anything happens, that gap is cheap. The moment an agent is wired to a tool that has a side effect — `send_email`, `charge_card`, `delete_row`, `post_to_slack` — the gap becomes the thing that decides whether a bad generation stays theoretical or becomes an incident.

## Three failure modes an approval gate actually addresses

- **Irreversibility.** Some actions can't be undone (an email sent, a message posted). A gate turns "already happened" into "still a draft."
- **Prompt injection from untrusted input.** An agent that reads a web page, an inbound email, or a support ticket before acting can have its next action steered by text embedded in that input. A human reviewing the *proposed action* — not the raw input — catches the divergence between "what the source said" and "what the agent is about to do."
- **Scale.** A bug that would be a minor annoyance done once becomes an incident when a loop runs it a thousand times unattended overnight. A gate means each instance is a separate decision, not a single point of failure that fires unbounded.

None of these require the agent to be malicious or even particularly buggy — a well-behaved agent following a subtly bad instruction produces the same failure.

## What a gate has to guarantee to actually be one

"Add a confirmation step to the prompt" is not a gate — it's a suggestion the model can talk itself past, and it leaves no record of who confirmed what. A real gate is a *data dependency*: the code path that performs the side effect literally cannot run until an external system returns a decision.

```typescript
async function proposeAndExecute(kind: string, title: string, body: string) {
  const create = await fetch("https://api.impri.dev/v1/actions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      kind,
      title,
      preview: { format: "markdown", body },
      expires_in: 3600,
      editable: ["preview.body"],
    }),
  });
  const { id } = await create.json();

  let decision;
  while (true) {
    const poll = await fetch(`https://api.impri.dev/v1/actions/${id}`, {
      headers: { Authorization: `Bearer ${process.env.IMPRI_API_KEY}` },
    });
    decision = await poll.json();
    if (decision.status !== "pending") break;
    await new Promise((r) => setTimeout(r, 10_000));
  }

  if (decision.status !== "approved") {
    return { executed: false, status: decision.status }; // rejected/expired — nothing happens
  }

  // The only line in this function that touches the real system:
  await runTheActualSideEffect(decision.decision.final_preview.body);

  await fetch(`https://api.impri.dev/v1/actions/${id}/result`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status: "executed" }),
  });
  return { executed: true };
}
```

`runTheActualSideEffect` is unreachable from any branch except the one guarded by `decision.status === "approved"`. That's what makes this a gate rather than a formality — there's no code path where the model's own confidence substitutes for the human's decision.

## Without a gate vs. with one

| | No gate | Gate in place |
|---|---|---|
| Bad generation reaches the real world | Immediately | Never, unless a human approves it |
| Audit trail of who allowed what | None | Every decision recorded with an actor and timestamp |
| Cost of a wrong action | Whatever the action does | One rejected draft |
| Agent can still run unattended | Yes, but unsupervised | Yes, up to the point of the side effect |

## What this doesn't solve

A gate only holds if the guarded path is the agent's *only* route to the side effect — if it still holds a standing API key it can call directly, the gate is bypassable. It also doesn't validate that the content is correct; a human still has to actually read the card, not rubber-stamp it. And it isn't a substitute for scoping what the agent can attempt in the first place — least-privilege tool access and a gate are complementary, not either/or. See [the propose-approve-execute pattern](the-propose-approve-execute-pattern.md) for the full shape of this, and [human-in-the-loop vs. full autonomy](human-in-the-loop-vs-full-autonomy.md) for when a gate is worth the added latency versus when it isn't.

## Next step

[The quickstart](quickstart.md) gets you an API key in a couple of minutes. If you're deciding between wiring this over plain REST or through MCP tool calls, [REST API vs. MCP for human approval](rest-api-vs-mcp-for-human-approval.md) walks through the trade-off.
