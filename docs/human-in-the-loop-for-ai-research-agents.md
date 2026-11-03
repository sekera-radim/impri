# Human-in-the-Loop for AI Research Agents

Human-in-the-loop for AI research agents: let the agent search and read freely, but hold the report or briefing it sends out until a person approves it.

A research agent is mostly harmless while it reads. It searches, fetches pages, summarises and compares, and none of that touches the outside world. The risk starts at the last step, when the findings leave your machine: a briefing emailed to a client, a report published to a wiki, a summary posted to a channel. This page shows where to put the gate for that kind of agent, and where not to.

---

## Gate the output, not the reading

The common mistake is to ask for approval at every tool call. A research run can make dozens of searches and fetches, and a human who approves each one stops looking at any of them. Split the agent's tools in two:

| Tool type | Examples | Gate? |
|-----------|----------|-------|
| Read-only | web search, page fetch, reading your own docs | No, let it run |
| Outbound | send the briefing, publish the report, write to a shared knowledge base | Yes, one approval per deliverable |

The reviewer then sees one card containing the finished report, which is the thing they actually want to judge. The question to ask is simply: *does this leave the sandbox?* If yes, it goes through the gate.

---

## Why research output deserves a human read

Research agents fail in quiet ways. A claim is attributed to the wrong source, a number comes from a page that was out of date, or a fetched page contained instructions aimed at the model rather than at you. None of these crash anything; they just produce a confident document. A person skimming the report with its sources listed catches most of them in a minute. Putting the sources inside the preview makes that check cheap.

---

## Example: hold the briefing until a person approves it

The agent finishes its research, then proposes sending the briefing instead of sending it. This is Python with plain `requests`, using the REST calls from the [model integration](how-to-add-human-approval-to-an-ai-agent.md):

```python
import os, time, requests

BASE = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}"}

def propose_briefing(run_id: str, report_md: str, sources: list[str]) -> dict:
    body = report_md + "\n\n---\n**Sources**\n" + "\n".join(f"- {s}" for s in sources)
    r = requests.post(f"{BASE}/v1/actions", headers=HEADERS, json={
        "kind": "report.send",
        "title": f"Market briefing, run {run_id}",
        "preview": {"format": "markdown", "body": body},
        "editable": ["preview.body"],     # reviewer can fix a claim before approving
        "expires_in": 14400,              # a stale briefing is not worth sending
        "idempotency_key": f"briefing-{run_id}",  # a retried run does not create a second card
    })
    r.raise_for_status()
    return r.json()

def wait_for_decision(action_id: str) -> dict:
    while True:
        a = requests.get(f"{BASE}/v1/actions/{action_id}", headers=HEADERS).json()
        if a["status"] != "pending":
            return a
        time.sleep(10)

action = propose_briefing("2026-11-03-a", report, sources)
result = wait_for_decision(action["id"])

if result["status"] == "approved":
    send_to_client(result["decision"]["final_preview"]["body"])  # your own sender
    requests.post(f"{BASE}/v1/actions/{action['id']}/result",
                  headers=HEADERS, json={"status": "executed"})
```

Three details matter here:

- **Send `final_preview`, not your original draft.** If the reviewer edited a sentence, the edited text is what goes out.
- **`idempotency_key` per run.** If the research job is retried after a crash, it reuses the same card instead of asking the reviewer twice.
- **`expires_in` is a correctness setting.** Research goes stale. When the action expires, treat it like a rejection and re-run the research if it is still needed.

---

## Make `send_to_client` the only way out

The gate is real only when the approved path is the agent's only path to the side effect. If the agent also holds your SMTP credentials or a Slack token, it can skip the card. Keep the credential inside `send_to_client`, which runs after the approval check, and do not expose it to the model as a tool. With an MCP client, the `impri_push_action`, `impri_await_decision` and `impri_report_result` tools in the [MCP server](mcp.md) cover the same three steps.

---

## Where the reviewer decides

The card shows up in the [inbox](inbox.md), and you can be pinged through [email, ntfy or web push](notifications.md), or approve from [Slack, Discord or Telegram](integrations.md). Every decision, including who decided and when, is kept in the [audit log](audit-log.md), which is useful when a client later asks which version of the report was approved.

---

## What Impri does not do here

Impri is only the approval gate. It stores the proposed action, notifies a person and holds the decision. It does not run the research, check whether the facts are right, or judge the sources; the reviewer does that. It does not send the briefing either, your code does. It is also not a workflow engine, so orchestrating the research steps stays in your agent framework.

---

## Next step

Get a key and push your first action with the [quickstart](quickstart.md), then wrap the one tool that sends your agent's findings out.
