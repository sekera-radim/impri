# Add Human Approval to Gemini CLI with Impri

Add human approval to Gemini CLI: connect the Impri MCP server so risky actions wait for your one-tap approve or reject before anything runs on your machine.

---

## Why a terminal prompt is not enough

Gemini CLI can read files, run shell commands and call tools on your behalf. The built-in confirmation prompts are useful, but they only work while you are sitting at that terminal. Start a long task, walk away, and the session either stalls or — if you pre-approved tools to keep it moving — runs unattended.

Impri adds a second kind of gate: the agent *proposes* an action, you get a card on your phone or in the inbox, and the agent only continues once the API reports `approved`. You can also edit the proposal before approving it, and every decision is kept in the audit log.

This page covers the practical setup. For the general pattern see [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md).

---

## Step 1 — register the Impri MCP server

Gemini CLI reads MCP servers from the `mcpServers` section of its `settings.json`. Add Impri there:

```json
{
  "mcpServers": {
    "impri": {
      "command": "npx",
      "args": ["@impri/mcp"],
      "env": {
        "IMPRI_API_KEY": "im_your_key_here",
        "IMPRI_BASE_URL": "https://api.impri.dev"
      }
    }
  }
}
```

Create the key with the `actions` scope only — see [API keys](api-keys.md). Self-hosting? Leave `IMPRI_BASE_URL` at its default of `http://localhost:8484` or point it at your own instance.

The server exposes three tools: `impri_push_action`, `impri_await_decision` and `impri_report_result`.

---

## Step 2 — tell the agent when it must ask

The tools are only called if the agent knows to call them. Put the rule in the project context file Gemini CLI loads (`GEMINI.md`):

```markdown
## Approval policy

Before you run any command that deletes files, pushes to a remote,
touches infrastructure, or sends anything outside this machine:

1. Call impri_push_action with kind "shell.exec", a short title, and a
   markdown preview containing the exact command and working directory.
2. Call impri_await_decision with the returned action_id.
3. Run the command only if status is "approved", and use the command
   from the returned preview — the reviewer may have edited it.
4. Call impri_report_result with "executed" or "execute_failed".

If the status is "rejected" or "expired", stop and report what happened.
```

A typical call from the agent then looks like this:

```
impri_push_action(
  kind="shell.exec",
  title="git push --force-with-lease origin release/2.4",
  preview={ format="markdown", body="```\ncd ~/work/api\ngit push --force-with-lease origin release/2.4\n```" },
  expires_in=1800,
  editable=["preview.body"]
)
impri_await_decision(action_id="act_...", timeout_s=900)
```

A short `expires_in` (the minimum is 300 seconds) suits commands: a push you approve an hour late may no longer be the push you meant.

---

## What this does and does not guarantee

This is the part worth reading twice. A line in `GEMINI.md` is an *instruction*, and a model can ignore an instruction. Impri on its own is not a sandbox: it stores the proposed action, notifies you and holds the decision. It does not run, interpret or intercept anything.

It becomes a real gate only when the approved path is the agent's **only** path to the side effect:

| Setup | Is it a real gate? |
|-------|--------------------|
| Instruction in `GEMINI.md`, agent still has an unrestricted shell | No — a convention the model can skip |
| Dangerous credentials (cloud keys, deploy tokens) are not in the agent's environment; only a wrapper that checks Impri holds them | Yes |
| Your own tool wrapper refuses to execute without an `approved` action | Yes |

So treat the policy file as the ergonomic layer and pair it with credential hygiene. Keep Gemini CLI's own sandbox and tool-confirmation settings on as well; Impri complements them rather than replacing them. Impri is also not a workflow engine and does not moderate content — it asks a human you trust.

---

## Notifications for away-from-keyboard sessions

The point of an out-of-band gate is that you do not have to watch the terminal. Configure [notifications](notifications.md) (email, ntfy or web push), or approve straight from chat via [Slack](slack-approval.md) or [Telegram](telegram-approval.md). Pending cards are also listed in the [inbox](inbox.md), where you can approve, reject or edit.

Remember that `impri_await_decision` blocks while it waits, so keep `timeout_s` modest and let the agent report a timeout instead of hanging for hours.

---

## Next step

Get a key and push your first test action with the [quickstart](quickstart.md), then read the [MCP guide](mcp.md) for the full tool reference.
