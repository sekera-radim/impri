# Human Approval Gates in the Claude Agent SDK

The Claude Agent SDK lets Claude run shell commands with real autonomy — here's how to gate the risky ones behind a human approval step before they execute.

---

## Where the risk actually sits

Agents built on the Claude Agent SDK (`claude-agent-sdk` for Python, `@anthropic-ai/claude-agent-sdk` for TypeScript) get their capabilities through tools — `Bash`, file edits, and any MCP servers you attach. Most of what an autonomous coding or ops agent does is safe to let run unattended: reading files, running tests, `git diff`. A smaller set of calls are not — `git push --force`, a deploy script, `kubectl delete`, `terraform apply`. Those are the ones worth pausing on.

The SDK already has a hook built for exactly this: `can_use_tool`, an async callback on `ClaudeAgentOptions` that fires whenever the CLI's permission rules would otherwise show an interactive "allow this tool?" prompt. It receives the tool name and its input and returns an allow or deny decision. That's the same shape as Impri's push → approve → execute pattern, so wiring the two together is a matter of making the callback block on a real human decision instead of a local prompt.

---

## Gating Bash calls with `can_use_tool`

```python
import os
import time
import requests
from claude_agent_sdk import (
    ClaudeSDKClient,
    ClaudeAgentOptions,
    PermissionResultDeny,
    ToolPermissionContext,
)

IMPRI_API_KEY = os.environ["IMPRI_API_KEY"]
IMPRI_BASE = "https://api.impri.dev"
GATED_PREFIXES = ("git push", "terraform apply", "kubectl delete", "rm -rf")

async def gate_bash(tool_name: str, tool_input: dict, context: ToolPermissionContext):
    if tool_name != "Bash":
        return {"behavior": "allow"}

    command = str(tool_input.get("command", ""))
    if not any(command.startswith(p) for p in GATED_PREFIXES):
        return {"behavior": "allow"}

    resp = requests.post(
        f"{IMPRI_BASE}/v1/actions",
        headers={"Authorization": f"Bearer {IMPRI_API_KEY}"},
        json={
            "kind": "shell.exec",
            "title": f"Run: {command[:80]}",
            "preview": {"format": "markdown", "body": f"```bash\n{command}\n```"},
            "expires_in": 1800,
        },
    )
    action_id = resp.json()["id"]

    while True:
        result = requests.get(
            f"{IMPRI_BASE}/v1/actions/{action_id}",
            headers={"Authorization": f"Bearer {IMPRI_API_KEY}"},
        ).json()
        if result["status"] != "pending":
            break
        time.sleep(5)

    if result["status"] == "approved":
        return {"behavior": "allow"}

    return PermissionResultDeny(
        behavior="deny",
        message=f"Command not approved (status: {result['status']}).",
        interrupt=False,
    )
```

Wire it in:

```python
async def main():
    options = ClaudeAgentOptions(can_use_tool=gate_bash)
    async with ClaudeSDKClient(options) as client:
        await client.connect(prompt="Cut the release branch and deploy it to staging.")
        async for msg in client.receive_response():
            print(msg)

anyio.run(main)
```

Claude keeps reasoning and calling tools normally. When it proposes a `Bash` call matching a gated prefix, `gate_bash` blocks that one call on an Impri decision before the SDK ever runs it. Everything else — reads, tests, non-matching commands — passes straight through.

---

## Why not `editable` here

Every other Impri REST integration in these docs sets `editable: ["preview.body"]` so a reviewer can fix a draft before approving. Skip it for this pattern. `can_use_tool` only returns allow or deny — it has no path to rewrite `tool_input["command"]` with an edited version, so an edited preview would silently have no effect on what actually runs. If you want reviewers to adjust a command, do it upstream of the shell string (have Claude regenerate it with feedback) and gate the result, rather than editing the executed text after the fact.

---

## `can_use_tool` vs a `PreToolUse` hook

`can_use_tool` only fires for calls that would have hit an interactive permission prompt — anything already covered by `allowed_tools`, `permission_mode`, or a `permissions.allow` rule never reaches it. If you need to observe or gate every tool call unconditionally, use a `PreToolUse` hook via the `hooks` option instead; note that a hook returning an allow decision skips `can_use_tool` for that call, so don't register both on the same tool without thinking through the order.

---

## Security notes

**Rate limit**: `POST /v1/actions` is capped at 60 requests per minute per key. An agent looping on a failing gated command will hit this before it hits anything more serious — treat repeated denials as a signal to stop, not retry harder.

**Scope**: a key used only for this gate needs the `actions` scope. Don't reuse an `admin`-scoped key for an agent process.

**Untrusted input**: if `command` was built from content Claude read off the web or a ticket, treat that content as data when constructing the preview shown to the reviewer — don't let it masquerade as part of your own instructions.

---

## Next step

- [Quickstart](quickstart.md) — get an API key and push your first action
- [Claude Agent SDK TypeScript integration](claude-agent-sdk.md) — a different approach: wrapping individual tool definitions instead of the permission hook
- [MCP server](mcp.md) — if you'd rather expose the gate as an MCP tool than call the REST API directly from the hook
