# Human-in-the-Loop for LlamaIndex Agents

LlamaIndex agents that write back to your knowledge base need a human check first — gate the publish step with Impri before any page is overwritten.

---

## When agentic RAG wants to write back

Most LlamaIndex agents are read-only: they retrieve chunks from an index and answer a question. Give the same agent a tool that can also *write* — update a wiki page, correct a stale runbook, patch a Confluence doc — and the retrieval half stays safe while the write half needs a gate. The agent noticing a doc is wrong is useful; the agent silently overwriting it is not.

A concrete version: a support-docs agent indexed over your internal wiki. When a user asks a question and the agent finds the matching page is out of date, it should draft the correction and hand it to a human, not publish over the source of truth on its own judgment.

---

## Gate the write with a FunctionTool

Keep your existing retrieval tool unrestricted — reads have no side effect — and add a second tool that only ever proposes a change. The propose → poll → publish sequence is the same one used everywhere in Impri, wrapped here in TypeScript for LlamaIndex.TS:

```typescript
import { FunctionTool, OpenAIAgent } from "llamaindex";

const IMPRI_BASE = "https://api.impri.dev";
const headers = {
  Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
  "Content-Type": "application/json",
};

async function proposeWikiUpdate(input: {
  pageId: string;
  title: string;
  newBody: string;
  reason: string;
}) {
  const action = await fetch(`${IMPRI_BASE}/v1/actions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "wiki.page.update",
      title: `Update wiki page: ${input.title}`,
      preview: { format: "markdown", body: `**Reason:** ${input.reason}\n\n---\n\n${input.newBody}` },
      editable: ["preview.body"],
      expires_in: 259200, // 3 days -- a doc correction is not urgent
      idempotent: true,   // publishing the same content twice is harmless
    }),
  }).then((r) => r.json());

  let state = action;
  while (state.status === "pending") {
    await new Promise((r) => setTimeout(r, 15_000));
    state = await fetch(`${IMPRI_BASE}/v1/actions/${action.id}`, { headers }).then((r) => r.json());
  }
  if (state.status !== "approved") {
    return `Not published -- reviewer ${state.status} the update.`;
  }

  const finalBody = state.decision.final_preview.body;
  const page = await publishToWiki(input.pageId, finalBody); // your wiki client

  await fetch(`${IMPRI_BASE}/v1/actions/${action.id}/result`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      status: "executed",
      payload: { pageId: page.id, url: page.url, revision: page.revision },
    }),
  });
  return `Published revision ${page.revision}: ${page.url}`;
}
```

`editable: ["preview.body"]` matters more here than in most gates — a reviewer who knows the doc will often fix a word rather than reject a mostly-right draft outright. Always publish `state.decision.final_preview.body`, not the `newBody` the agent proposed, since that is the version the human signed off on.

---

## Wiring the tool into the agent

```typescript
const updateTool = FunctionTool.from(proposeWikiUpdate, {
  name: "propose_wiki_update",
  description:
    "Propose a correction to an internal wiki page. The page is not changed until a human approves it.",
  parameters: {
    type: "object",
    properties: {
      pageId: { type: "string" },
      title: { type: "string" },
      newBody: { type: "string", description: "Corrected page content, in markdown." },
      reason: { type: "string", description: "Why the current page is stale or wrong." },
    },
    required: ["pageId", "title", "newBody", "reason"],
  },
});

const agent = new OpenAIAgent({
  tools: [searchTool, updateTool], // searchTool is your existing read-only retrieval tool
  systemPrompt:
    "Answer questions from the indexed docs. If a page you retrieved is stale or wrong, " +
    "call propose_wiki_update instead of only saying so in the chat response.",
});

const response = await agent.chat({ message: "Is the on-call escalation doc still accurate?" });
```

The agent answers the user immediately from what it retrieved — the approval wait happens independently, and the correction lands whenever a human gets to it.

---

## Reporting what happened back to the card

The `payload` field on `POST /v1/actions/:id/result` is what turns "approved" into a receipt. Here it carries the published page's id, URL, and new revision number — all three show up on the Impri card and come back from `GET /v1/actions/:id` as `result_payload`. Without it you would know the update was approved but still have to go dig up the resulting page yourself.

---

## Keep search and write on separate tools

A few things worth being deliberate about:

- **Don't gate retrieval.** Wrapping the read-only search tool in the same flow adds latency to every question and trains reviewers to rubber-stamp cards.
- **Long expiry, not short.** A wiki correction is not time-sensitive the way a refund or an incident reply is; three days beats forcing same-hour review.
- **One write tool per side effect.** A raw wiki API key handed to the agent "just in case" turns this gate decorative.

---

## What Impri is not doing here

Impri stores the proposed page content, notifies a reviewer, and holds the decision — it does not read the wiki or know if the correction is factually right, and it never calls your wiki API. `publishToWiki(...)` is still your code, called only after `state.status === "approved"`. Impri is the gate; judging the content is still the human's job, same as reviewing a pull request.

---

## Next step

Get an API key with the `actions` scope from the [quickstart](quickstart.md), swap the raw `fetch` calls above for the [TypeScript SDK](sdk-typescript.md) once this leaves prototype stage, and see [webhooks](webhooks.md) if polling every 15 seconds is too chatty for a background job.
