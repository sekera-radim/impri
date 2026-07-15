# Integrations

Impri integrates with agent frameworks and runtime environments through two paths: the **MCP server** (drop-in for any MCP-compatible client) and the **REST API** (used directly or via the SDK wrappers). The patterns below show how each framework fits into the Impri approval loop.

> The SDKs at `sdk/python/` and `sdk/typescript/` are v0.1, pre-release. MCP, raw REST, and all framework integrations documented here are available today.

---

## MCP server (Claude Code, Claude Desktop, any MCP client)

The `@impri/mcp` package is the fastest way to add human approval to any MCP-compatible agent. No SDK needed.

```bash
npx @impri/mcp
# cloud:      IMPRI_API_KEY=im_...  IMPRI_BASE_URL=https://api.impri.dev
# self-host:  IMPRI_API_KEY=im_...  IMPRI_BASE_URL=http://localhost:8484
```

Add to `~/.claude/mcp.json` (or your client's MCP config file):

```json
{
  "mcpServers": {
    "impri": {
      "command": "npx",
      "args": ["@impri/mcp"],
      "env": {
        "IMPRI_API_KEY": "im_<your-key>",
        "IMPRI_BASE_URL": "https://api.impri.dev"
      }
    }
  }
}
```

Cloud endpoint:

```json
"IMPRI_BASE_URL": "https://api.impri.dev"
```

Available tools the agent can call:

| Tool | What it does |
|------|-------------|
| `impri_push_action` | Submit an action for human approval |
| `impri_await_decision` | Poll until decided (default timeout 300 s) |
| `impri_report_result` | Report execution outcome after approval |
| `impri_inbox_status` | Count pending actions |
| `impri_create_watcher` | Create a watcher (rss / reddit_search / url_diff) |
| `impri_list_watchers` | List watchers, optional status filter |

The agent calls these tools in sequence: `impri_push_action` → `impri_await_decision` → execute → `impri_report_result`. The MCP server handles all HTTP and polling internally.

See [Quickstart](quickstart.md) for a step-by-step walkthrough inside a Claude Code session.

---

## LangChain / LangGraph

The `integrations/langchain/` package provides a ready-made `ImpriApprovalTool` class (a `BaseTool` subclass) and a `wrap()` factory. The pattern for custom tools is:

```python
from langchain.tools import BaseTool
from impri import ImpriClient, ImpriRejected

client = ImpriClient()  # reads IMPRI_API_KEY, IMPRI_BASE_URL from env

class ApprovedEmailTool(BaseTool):
    name = "send_email"
    description = "Send an email — requires human approval before sending."

    async def _arun(self, to: str, body: str) -> str:
        async with client.approval_gate(
            kind="email.send",
            title=f"Send email to {to}",
            preview={"format": "plain", "body": body},
            editable=["preview.body"],
            timeout_s=300,
        ) as approved:
            # Use the human-approved (possibly edited) body
            await mailer.send(to=to, body=approved.final_preview["body"])
        return "Sent."
```

The `approval_gate` context manager calls `report_result` automatically on both clean exit and exception, so you do not need to handle that in the tool.

**LangGraph interrupt pattern**

For LangGraph graphs that use the `interrupt` mechanism, push an action and store the `action_id` in the graph state, then surface it to the frontend. The frontend polls or receives a webhook and resumes the graph with the decision:

```python
async def approval_node(state: GraphState) -> GraphState:
    action = await client.create_action(
        kind=state["planned_action"],
        title=state["proposed_title"],
        preview={"format": "markdown", "body": state["proposed_body"]},
        editable=["preview.body"],
    )
    # store for the next node; the graph can be interrupted here
    return {**state, "pending_action_id": action.id, "inbox_url": action.inbox_url}

async def execute_node(state: GraphState) -> GraphState:
    action = await client.get_action(state["pending_action_id"])
    if action.status == "approved":
        body = action.decision.final_preview["body"]
        await perform(body)
        await client.report_result(action.id, "executed")
    return state
```

---

## OpenAI Agents SDK

The `integrations/openai-agents/` package provides a `make_guardrail()` factory that returns an `InputGuardrail`. Use `@client.requires_approval` directly on the function you pass to `FunctionTool`:

```python
from agents import FunctionTool
from impri import ImpriClient, ImpriRejected

client = ImpriClient()

@client.requires_approval(
    kind="code.exec",
    title=lambda code, **_: f"Execute: {code[:60]}",
    preview=lambda code, **_: {"format": "plain", "body": code},
    editable=["preview.body"],
)
async def run_python(code: str) -> str:
    return subprocess.check_output(["python", "-c", code], text=True)

tools = [FunctionTool(run_python)]
```

When the agent calls `run_python`, the decorator intercepts it, pushes an approval action, blocks until decided, then either calls the real function or raises `ImpriRejected`. The agent framework sees the exception as a tool error and can handle it in its error loop.

**Run-level guardrail with `make_guardrail()`**

For gating every agent run (not just individual tool calls), use the `InputGuardrail` factory from `integrations/openai-agents/`:

```bash
pip install 'impri-openai[openai-agents]'
```

```python
from agents import Agent, Runner
from impri_openai import ImpriClient
from impri_openai.guardrail import make_guardrail

client = ImpriClient()                    # reads IMPRI_API_KEY from env

approval = make_guardrail(
    client,
    kind="agent.run",
    title="Approve this agent task",
    preview_from_input=True,              # show the user's input in the inbox card
    timeout_s=300,
)

agent = Agent(
    name="my-agent",
    instructions="You are a helpful assistant.",
    input_guardrails=[approval],
)
result = await Runner.run(agent, "Summarise my emails")
```

Key parameters:

| Parameter | Default | Description |
|---|---|---|
| `kind` | `'agent.run'` | Action kind for inbox categorisation |
| `title` | `'Agent run requires human approval'` | Title shown in the inbox card |
| `preview_from_input` | `True` | When `True`, the user's raw input is shown as the preview body so the reviewer sees exactly what the agent was asked to do. When `False`, shows a generic `"Agent '<name>' was triggered."` message instead. |
| `timeout_s` | `300` | Seconds to wait for a human decision |
| `editable` | `None` | Dot-path fields the reviewer may edit before approving |

**Return semantics:** The guardrail returns a `GuardrailFunctionOutput` with:
- `tripwire_triggered=False` when the human **approves** — the agent proceeds normally.
- `tripwire_triggered=True` when the human **rejects** — the OpenAI Agents runner raises `InputGuardrailTripwireTriggered`, halting the run.

`output_info` always contains `{"action_id": "...", "verdict": "approve" | "reject"}` so calling code can inspect the Impri action after the guardrail returns.

---

## CrewAI

The `integrations/crewai/` directory ships a dedicated `impri-crewai` package with two integration classes: **`ImpriApprovalTool`** (agent-initiated gating) and **`ImpriApprovalCallback`** (automatic step/task gating). Install the package first:

```bash
pip install impri-crewai
# or with crewai bundled as an extra:
pip install "impri-crewai[crewai]"
```

### ImpriApprovalTool — agent-initiated approval

`ImpriApprovalTool` is a CrewAI `BaseTool` that the agent calls explicitly when it wants to request human approval for a specific action. The agent provides a title and body describing the action; the tool blocks until the human decides.

```python
import os
from crewai import Agent, Crew, Task
from impri_crewai import ImpriClient, ImpriApprovalTool, ImpriRejected

client = ImpriClient(api_key=os.environ["IMPRI_API_KEY"])

approval_tool = ImpriApprovalTool(
    client=client,
    action_kind="email.send",   # dot-namespaced category for inbox filtering
    timeout_s=600,              # seconds to wait for human decision (default 300)
    editable=["preview.body"],  # fields the reviewer may edit before approving
)

agent = Agent(
    role="Marketing assistant",
    goal="Draft and send campaign emails with human sign-off.",
    backstory="You help marketing teams communicate with customers.",
    tools=[approval_tool],
)

task = Task(
    description=(
        "Draft a follow-up email to newsletter subscribers and send it "
        "after getting human approval."
    ),
    expected_output="Confirmation that the email was approved and sent.",
    agent=agent,
)

crew = Crew(agents=[agent], tasks=[task])
try:
    result = crew.kickoff()
except ImpriRejected as exc:
    print(f"Human rejected the action: {exc}")
```

The agent calls the tool with three arguments (filled automatically from its description):

| Input field | Description |
|---|---|
| `action_title` | Short human-readable title (max ~120 chars). Shown at the top of the inbox card. |
| `action_body` | Full description of the proposed action. The reviewer reads this before deciding. Supports markdown. |
| `preview_format` | Format of `action_body`: `'markdown'`, `'plain'`, or `'diff'`. Defaults to `'markdown'`. |

On **approval**, the tool returns the final (possibly human-edited) content as a string the agent can read. On **rejection**, `ImpriRejected` is raised — CrewAI surfaces it as a tool error so the agent can handle it gracefully.

### ImpriApprovalCallback — automatic step/task gating

`ImpriApprovalCallback` is a callable that wires into CrewAI's `step_callback` or `task_callback`. It intercepts agent outputs automatically, without modifying agent prompts or tool lists.

```python
import os
from crewai import Agent, Crew, Task
from impri_crewai import ImpriClient, ImpriApprovalCallback, ImpriRejected

client = ImpriClient(api_key=os.environ["IMPRI_API_KEY"])

gate = ImpriApprovalCallback(
    client,
    action_kind="agent.output",         # kind string for inbox categorisation
    timeout_s=300,                      # seconds to wait (default 300)
    title_prefix="Review agent draft",  # prepended to the auto-generated title
)

agent = Agent(
    role="Content writer",
    goal="Write blog posts.",
    backstory="...",
)

task = Task(
    description="Write a 500-word blog post about Impri.",
    expected_output="A complete blog post.",
    agent=agent,
)

crew = Crew(
    agents=[agent],
    tasks=[task],
    step_callback=gate,   # gate every intermediate step output
    # task_callback=gate  # alternative: gate only the final task output
)

try:
    result = crew.kickoff()
except ImpriRejected as exc:
    print(f"Step rejected by human reviewer: {exc}")
```

`ImpriApprovalCallback` constructor parameters:

| Parameter | Default | Description |
|---|---|---|
| `client` | required | An `ImpriClient` configured with your API key |
| `action_kind` | `'agent.output'` | Kind string for inbox categorisation |
| `timeout_s` | `300` | Seconds to wait for a human decision |
| `title_prefix` | `'Review agent output'` | Prefix prepended to the auto-generated action title |
| `editable` | `['preview.body']` | Dot-path fields the reviewer may edit |

> **Note:** CrewAI callbacks are invoked for their side effects and their return value is ignored, so `ImpriApprovalCallback` cannot inject the reviewer's edits back into the agent flow. If you need the human-edited content to feed back into the agent, use `ImpriApprovalTool` instead.

On rejection, `ImpriRejected` propagates from the callback into `crew.kickoff()`, surfacing as a task failure. `ImpriTimeout` (human did not decide within `timeout_s`) propagates the same way.

---

## Claude Agent SDK (Anthropic)

The `integrations/claude-agent-sdk/` package provides a TypeScript `GatedTool` that intercepts `tool_use` content blocks before execution. The tool definition is passed to Claude unchanged — only the execution path goes through Impri.

```typescript
import { ImpriClient } from '@impri/sdk'
import { withImpriApproval } from '@impri/claude-agent-sdk'

const impri = new ImpriClient({ apiKey: process.env.IMPRI_API_KEY! })

const sendEmailGated = withImpriApproval({
  toolDef: {
    name: 'send_email',
    description: 'Send an email to a recipient.',
    input_schema: {
      type: 'object',
      properties: {
        to:   { type: 'string' },
        body: { type: 'string' },
      },
      required: ['to', 'body'],
    },
  },
  execute: async ({ to, body }) => {
    await emailService.send({ to: String(to), body: String(body) })
    return `Email sent to ${to}.`
  },
  impriClient: impri,
  kind: 'email.send',
  title: ({ to }) => `Send email to ${to}`,
  preview: ({ body }) => ({ format: 'plain', body: String(body) }),
  editable: ['preview.body'],
  onRejected: (err) => `Email rejected (action ${err.actionId}).`,
})

// In your agent loop:
const response = await anthropic.messages.create({
  model: 'claude-opus-4-5',
  tools: [sendEmailGated.toolDef],  // unchanged — Claude sees the normal tool
  messages,
})

for (const block of response.content) {
  if (block.type === 'tool_use' && block.name === 'send_email') {
    const result = await sendEmailGated.handle(block)
    // feed result back to Claude as tool_result
  }
}
```

`withImpriApproval` creates a `GatedTool` with:
- `toolDef` — the original Anthropic tool definition, unchanged
- `handle(block)` — call for each matching `tool_use` block; submits to Impri, waits for approval, executes, reports result; returns a string for `tool_result`
- `execute` — the underlying executor, available for direct testing

When the reviewer edits `preview.body` and the tool input has a `body` field, the edited value is injected before calling `execute()`. Call `reportResult` is handled automatically inside `handle()`.

Full reference: [Claude Agent SDK](claude-agent-sdk.md)

---

## n8n

Use the **HTTP Request** node to call the Impri REST API directly. A two-node pattern works for most workflows:

1. **HTTP Request** node: `POST /v1/actions` with your agent's proposed content.
2. **Wait** node: wait for a webhook callback (`callback_url` set in step 1) or poll `GET /v1/actions/:id` on a schedule.
3. **IF** node: branch on `status === "approved"` / `"rejected"`.
4. **Execute** and then **HTTP Request** node: `POST /v1/actions/:id/result`.

Set `Authorization: Bearer im_<key>` as a credential in n8n's **Header Auth** section and reference it in all Impri nodes.

Webhook delivery: set `callback_url` to your n8n webhook URL. n8n's Webhook node receives the decision and resumes the workflow. Signature verification can be done in a Function node using the algorithm in [webhooks.md](webhooks.md).

---

## Make (Integromat)

Use the **HTTP** module with method `POST` and URL `https://api.impri.dev/v1/actions` (cloud) or your self-hosted base URL. Headers: `Authorization: Bearer im_<key>`, `Content-Type: application/json`.

Body (JSON template):

```json
{
  "kind": "{{1.kind}}",
  "title": "{{1.title}}",
  "preview": { "format": "plain", "body": "{{1.body}}" },
  "callback_url": "https://hook.make.com/<your-scenario-webhook>",
  "expires_in": 86400
}
```

The `callback_url` points back to a Make **Custom webhook** that resumes the scenario when the human decides. Use a **Router** module to branch on `status`.

---

## Zapier

Use the **Webhooks by Zapier** action with `POST` to push an action. For the decision, add an inbound webhook as the trigger of a second Zap, or use Zapier's **Delay Until** step while polling `GET /v1/actions/:id`.

---

## Webhook receiver patterns

For servers that receive Impri webhook deliveries, the pattern is consistent regardless of framework:

```typescript
// Express / Fastify / Hono (TypeScript)
import { verifyWebhook, ImpriWebhookSignatureError } from '@impri/sdk'

app.post('/impri/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    verifyWebhook(
      req.body,
      process.env.IMPRI_WEBHOOK_SECRET!,
      req.headers['x-impri-timestamp'] as string,
      req.headers['x-impri-nonce'] as string,
      req.headers['x-impri-signature'] as string,
    )
  } catch (e) {
    if (e instanceof ImpriWebhookSignatureError) return res.status(400).end()
    throw e
  }

  const event = JSON.parse(req.body.toString())
  if (event.status === 'approved') {
    await enqueue({ actionId: event.action_id, body: event.final_preview?.body })
  }
  res.status(200).end()
})
```

```python
# FastAPI / Flask / Django (Python)
import impri
from impri import ImpriWebhookSignatureError

@app.post("/impri/webhook")
async def webhook(request: Request):
    raw = await request.body()
    try:
        impri.verify_webhook(
            raw_body=raw,
            secret=os.environ["IMPRI_WEBHOOK_SECRET"],
            timestamp=request.headers["X-Impri-Timestamp"],
            nonce=request.headers["X-Impri-Nonce"],
            signature=request.headers["X-Impri-Signature"],
        )
    except ImpriWebhookSignatureError:
        raise HTTPException(status_code=400)

    event = await request.json()
    if event["status"] == "approved":
        await enqueue(action_id=event["action_id"], body=event["final_preview"]["body"])
    return Response(status_code=200)
```

Key rules:
- Verify the signature before processing. Never trust the payload without it.
- Respond `200` quickly (within a few seconds); do the heavy work asynchronously.
- Return `410 Gone` to permanently deregister a callback URL.
- If your endpoint is temporarily unavailable, let it return a non-2xx — Impri will retry up to 6 times over 12 hours. Polling is always available as a fallback.

Full signature algorithm and retry schedule: [webhooks.md](webhooks.md).

---

## Self-hosted vs. cloud

| | Self-hosted | Cloud (api.impri.dev) |
|---|---|---|
| Status | Complete, MIT | Early beta |
| Base URL | `http://localhost:8484` (default) | `https://api.impri.dev` |
| Setup | `docker compose up` | Create account at app.impri.dev |
| API surface | Full | Full |
| Watcher limits | None | Per-tier |
| Approval quota | None | Per-tier |
| Support | Community / issues | — |

For both: set `IMPRI_BASE_URL` (or the `baseUrl` constructor argument) to the appropriate endpoint. The API surface is identical.
