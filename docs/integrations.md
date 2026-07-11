# Integrations

Impri integrates with agent frameworks and runtime environments through two paths: the **MCP server** (drop-in for any MCP-compatible client) and the **REST API** (used directly or via the SDK wrappers). The patterns below show how each framework fits into the Impri approval loop.

> The SDKs at `sdk/python/` and `sdk/typescript/` are v0.1, pre-release. MCP and raw REST are available today. Framework-specific integration libraries are listed here as the intended integration pattern.

---

## MCP server (Claude Code, Claude Desktop, any MCP client)

The `@impri/mcp` package is the fastest way to add human approval to any MCP-compatible agent. No SDK needed.

```bash
npx @impri/mcp
# env: IMPRI_API_KEY=im_...  IMPRI_BASE_URL=http://localhost:8484
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
        "IMPRI_BASE_URL": "http://localhost:8484"
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

The intended path is a custom `Tool` that wraps the Python SDK's `approval_gate` context manager. The sibling file `integrations/langchain/` (being written in parallel) will provide a ready-made `HumanApprovalTool` class. Until it ships, the pattern is:

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

The sibling file `integrations/openai-agents/` (being written in parallel) will provide a `HumanApprovalHook` for the OpenAI Agents Python SDK. Until it ships, use the `@client.requires_approval` decorator directly on the function you pass to `FunctionTool`:

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

---

## CrewAI

Wrap a CrewAI `Tool` with the `requires_approval` decorator in the same pattern as LangChain. CrewAI agents are synchronous by default, so use the synchronous variant:

```python
from crewai_tools import tool
from impri import ImpriClient

client = ImpriClient()

@tool("Send email with human approval")
@client.requires_approval(
    kind="email.send",
    title=lambda to, **_: f"Send email to {to}",
    preview=lambda to, body, **_: {"format": "plain", "body": body},
    editable=["preview.body"],
)
def send_email(to: str, body: str) -> str:
    mailer.send(to=to, body=body)
    return f"Email sent to {to}."
```

The Python SDK provides both `async` and sync variants of `requires_approval` and `approval_gate`.

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
