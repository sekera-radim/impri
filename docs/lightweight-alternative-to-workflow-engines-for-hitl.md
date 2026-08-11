# A Lightweight Alternative to Workflow Engines for HITL

If you only need one human checkpoint in an otherwise automated agent pipeline, standing up n8n or Temporal for that single yes/no is overkill — Impri adds the approval gate as three API calls with no workflow engine to run.

---

## The situation this is for

You have a content pipeline: an agent researches a topic, drafts a post, and wants to publish it to your company blog and cross-post to X. Everything up to "publish" is fine to automate. The publish step is not — a bad take going out under your brand's name is expensive to walk back.

The instinct is often to reach for a workflow engine, since "wait for human input" sounds like a workflow node. But bringing in n8n, Temporal, or Inngest for a pipeline that is otherwise just "generate, then post" means running and maintaining an orchestration platform — persistence, workers, a UI, deployment — for what is functionally one pause-and-resume point.

---

## What you actually need for one gate

Three things: somewhere to park the pending action, a way to notify a human, and a way for your existing script to resume once a decision exists. That's the entire feature set Impri provides — no DAGs, no node graph, no separate deployment beyond the API itself (or a self-hosted binary, if you'd rather not depend on the cloud service).

Here's the same publish pipeline with the gate added, as a plain TypeScript script — no orchestration framework in sight:

```typescript
import { setTimeout as sleep } from "node:timers/promises";

const API = "https://api.impri.dev";
const headers = {
  Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
  "Content-Type": "application/json",
};

interface Decision {
  status: "pending" | "approved" | "rejected" | "expired";
  decision?: { final_preview: { body: string } };
}

async function gatePublish(title: string, draft: string): Promise<Decision> {
  const create = await fetch(`${API}/v1/actions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      kind: "blog.publish",
      title: `Publish: ${title}`,
      preview: { format: "markdown", body: draft },
      expires_in: 43200, // 12h
      editable: ["preview.body"],
    }),
  }).then((r) => r.json());

  while (true) {
    const check: Decision = await fetch(`${API}/v1/actions/${create.id}`, { headers }).then((r) =>
      r.json()
    );
    if (check.status !== "pending") return check;
    await sleep(10_000);
  }
}

async function run() {
  const draft = await generateBlogPost("distributed tracing pitfalls"); // your existing step
  const decision = await gatePublish("Distributed tracing pitfalls", draft);

  if (decision.status === "approved") {
    const finalBody = decision.decision!.final_preview.body;
    await publishToBlog(finalBody);
    await crossPostToX(finalBody);
  } else {
    console.log(`Publish skipped: ${decision.status}`);
  }
}

run();
```

No engine process, no separate UI to deploy, no node-graph config to version. The pipeline is still "just a script" — it has one `await` that happens to resolve only when a human decides.

---

## Where this stops being the right fit

Impri is deliberately narrow, and that's the tradeoff for being lightweight. It is not a substitute for a workflow engine once your pipeline actually needs orchestration features:

| You need | Reach for |
|---|---|
| One pause for a yes/no/edit decision | Impri |
| Branching logic across many conditions after the decision | A workflow engine's HITL node, or your own code — Impri gives you the decision, not the branching |
| Scheduling, retries-with-backoff across multiple steps, long-running state machines | Temporal, Inngest |
| Visual pipeline building for non-engineers | n8n |
| Multiple agents coordinating with each other | A workflow engine or agent framework — Impri gates one agent's action, it doesn't hand off between agents |

The two aren't mutually exclusive, either: if you already run n8n for the rest of the pipeline, you can call Impri's REST API from an HTTP Request node and get the lightweight approval card without adopting n8n's own (heavier) human-in-the-loop pattern for this one step. See the [integrations guide](integrations.md) for wiring Impri into an existing pipeline rather than replacing it.

---

## What you get for the tradeoff

By staying out of orchestration, Impri stays out of your pipeline's control flow — it's an `await` in a script, not a graph your script lives inside. That means:

- No new infra to run if you're on the hosted version at `api.impri.dev`.
- The rest of your pipeline is still ordinary code you can test, debug, and version like anything else.
- Adding or removing the gate is a diff of a few lines, not a rewrite into a different execution model.

The cost is that you get exactly one primitive — propose, notify, decide — and nothing to model complex branching with. For a single checkpoint in an otherwise scripted pipeline, that's usually the right amount of tool.

---

## Try it

Full walkthrough with both REST and MCP flows: [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md). For webhook-based notification into your own systems instead of polling, see [webhooks](webhooks.md). More integration patterns, including chaining with existing tools, are in the [cookbook](cookbook.md).

Get an API key and try the script above in a few minutes: [quickstart](quickstart.md).
