# impri-crewai

Human-in-the-loop approval gate for [CrewAI](https://crewai.com) agents, powered by [Impri](https://impri.dev).

An agent proposes an action. A human approves or rejects it in the Impri inbox. The agent executes only after approval — the tool call blocks until the human decides.

---

## Installation

```bash
pip install impri-crewai crewai        # from source until published to PyPI
# or, with the extras shorthand:
pip install "impri-crewai[crewai]"
```

The core package has **zero runtime dependencies** beyond stdlib. CrewAI is an optional dependency — the module imports cleanly without it (useful in test environments).

---

## Quick start

```python
import os
from crewai import Agent, Task, Crew
from impri_crewai import ImpriClient, ImpriApprovalTool, ImpriRejected

# 1. Configure the client. Falls back to the IMPRI_API_KEY env var.
client = ImpriClient(
    api_key=os.environ["IMPRI_API_KEY"],
    # base_url defaults to http://localhost:8484 (self-hosted)
    # use "https://api.impri.dev" for the cloud
)

# 2. Create the approval tool. action_kind groups actions in the inbox.
approval_tool = ImpriApprovalTool(
    client=client,
    action_kind="email.send",
    timeout_s=600,  # wait up to 10 minutes for a human decision
)

# 3. Give the tool to your agent.
agent = Agent(
    role="Marketing assistant",
    goal="Draft and send campaign emails, always requesting human approval first.",
    backstory=(
        "You are careful and thorough. Before sending any email, you use the "
        "impri_approval_gate tool to submit your draft for human review."
    ),
    tools=[approval_tool],
    verbose=True,
)

task = Task(
    description=(
        "Draft a short welcome email to onboard@acme.com. "
        "Use the impri_approval_gate tool to submit it for review. "
        "If approved, confirm it has been sent."
    ),
    expected_output="Confirmation that the draft was approved and sent.",
    agent=agent,
)

crew = Crew(agents=[agent], tasks=[task])

try:
    result = crew.kickoff()
    print(result)
except ImpriRejected as exc:
    # The human pressed Reject in the inbox — not an error, a valid outcome.
    print(f"Action rejected: {exc}")
```

Open your Impri inbox (`http://localhost:8080` self-hosted, or `https://app.impri.dev` cloud) to approve or reject the card that appears.

---

## Two integration patterns

### Pattern A — `ImpriApprovalTool` (recommended)

The agent explicitly requests approval via a tool call. Best when:
- The agent decides which actions need a human gate.
- You want the human-edited content fed back into the agent's reasoning.

The tool's `_run` method:
1. POSTs the action to Impri (`POST /v1/actions`).
2. Polls `GET /v1/actions/:id` every 5 s until the human decides.
3. On approval: returns `"APPROVED. Proceed with:\n\n{final_content}"` — the agent reads this and proceeds.
4. On rejection: raises `ImpriRejected` — CrewAI surfaces this as a tool error, and the agent can handle or stop.

```python
tool = ImpriApprovalTool(
    client=client,
    action_kind="db.exec",    # free-form kind string, shown in the inbox
    timeout_s=300,            # raise ImpriTimeout after this many seconds
    editable=["preview.body"],# fields the reviewer may edit before approving
)
```

### Pattern B — `ImpriApprovalCallback`

Wire into CrewAI's `step_callback` or `task_callback` to gate every output automatically, without changing agent prompts or tool lists:

```python
from impri_crewai import ImpriApprovalCallback

gate = ImpriApprovalCallback(
    client,
    action_kind="agent.output",
    title_prefix="Review before publishing",
    timeout_s=300,
)

crew = Crew(
    agents=[agent],
    tasks=[task],
    task_callback=gate,   # called once per completed task
    # step_callback=gate  # called after every intermediate step
)
```

**Limitation:** CrewAI ignores callback return values, so the human-edited content is not injected back into the agent flow. The callback is best for hard-blocking on rejection. For round-trip edit feedback, use `ImpriApprovalTool`.

---

## Configuration

| Parameter | Source (priority order) | Default |
|---|---|---|
| `api_key` | Constructor → `IMPRI_API_KEY` env var | *(required)* |
| `base_url` | Constructor → `IMPRI_BASE_URL` env var | `http://localhost:8484` |

```bash
# Self-hosted
export IMPRI_API_KEY=im_...

# Impri cloud
export IMPRI_API_KEY=im_...
export IMPRI_BASE_URL=https://api.impri.dev
```

---

## Handling outcomes

```python
from impri_crewai import ImpriRejected, ImpriTimeout, ImpriExpired

try:
    result = crew.kickoff()
except ImpriRejected as exc:
    # Human pressed Reject. Not an error — log it and move on.
    print(f"Rejected: action_id={exc.action_id}")

except ImpriTimeout as exc:
    # No human decision within timeout_s. Action is still pending on the server.
    # You can call await_decision again with the same action_id to keep waiting.
    print(f"Timed out waiting for {exc.action_id}")

except ImpriExpired:
    # The action's expires_at timestamp passed with no decision.
    # Create a new action if the task is still relevant.
    print("Approval window closed.")
```

---

## Webhook signature verification

If you set a `callback_url` on your actions and want to verify Impri's signed webhook deliveries:

```python
from impri_crewai import verify_webhook, ImpriWebhookSignatureError

# In your webhook handler (framework-agnostic):
raw_body: bytes = request.body            # do not decode
timestamp: str  = request.headers["X-Impri-Timestamp"]
nonce: str      = request.headers["X-Impri-Nonce"]
signature: str  = request.headers["X-Impri-Signature"]
secret: str     = os.environ["IMPRI_WEBHOOK_SECRET"]  # from GET /v1/project

try:
    verify_webhook(raw_body, secret, timestamp, nonce, signature)
except ImpriWebhookSignatureError:
    return 403
```

---

## Running the tests

```bash
cd integrations/crewai
pip install pytest
pytest                    # runs without crewai — CrewAI tests are skipped
pip install crewai
pytest                    # runs all tests
```

Tests use an injectable transport, so there are no network calls and no patching of stdlib internals.

---

## How it works

```
Agent                Impri inbox               Human
  │                       │                      │
  │── tool call ──────────►                      │
  │   (create_action)     │                      │
  │                       │── notification ──────►
  │   (polling...)        │                      │
  │                       │◄── approve/reject ───│
  │◄── tool result ───────│
  │   (or ImpriRejected)  │
```

The agent never executes without an explicit human decision. `ImpriApprovalTool._run` blocks synchronously during the polling loop, keeping the integration stateless from the agent's perspective.

---

## License

MIT — same as the Impri core. See [LICENSE](../../LICENSE).
