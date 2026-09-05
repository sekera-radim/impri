# Approve Terminal Commands Before Your AI Coding Agent Runs Them

Gate the shell commands an autonomous coding agent wants to run — `rm`, `git push`, `npm publish` — behind a human approval so nothing destructive executes unattended.

---

## The specific risk with coding agents

A coding agent that can run arbitrary shell commands is, by design, one bad plan away from `rm -rf` on the wrong directory, a force-push over a colleague's branch, or a `npm publish` that ships a half-finished package. Prompt-based safeguards ("ask before doing anything destructive") are advisory — the model can talk itself past its own instructions, especially under a long context or a misleading tool result. What actually stops the command is the executor never running it without an external decision.

The pattern below wraps the agent's command-execution tool so every command that isn't on a pre-approved allowlist goes through Impri first — and the wrapper, not the model, decides whether the real `subprocess.run` call ever happens.

---

## Wrapping the executor

```python
import subprocess
import time
import requests

IMPRI_BASE = "https://api.impri.dev"
HEADERS = {"Authorization": f"Bearer {IMPRI_API_KEY}"}

SAFE_PREFIXES = ("ls", "cat", "git status", "git diff", "git log", "pytest", "npm test")

def run_command(cmd: str) -> str:
    if cmd.strip().startswith(SAFE_PREFIXES):
        return _execute(cmd)

    action = requests.post(f"{IMPRI_BASE}/v1/actions", headers=HEADERS, json={
        "kind": "shell.execute",
        "title": f"Run command: {cmd[:60]}",
        "preview": {"format": "plain", "body": cmd},
        "expires_in": 1800,
        "editable": ["preview.body"],
    }).json()

    action_id = action["id"]
    while True:
        time.sleep(5)
        result = requests.get(f"{IMPRI_BASE}/v1/actions/{action_id}", headers=HEADERS).json()
        if result["status"] != "pending":
            break

    if result["status"] != "approved":
        return f"Command not run — decision was '{result['status']}'"

    # A reviewer may have tightened the command before approving; run their version
    approved_cmd = result["decision"]["final_preview"]["body"]
    output = _execute(approved_cmd)

    requests.post(f"{IMPRI_BASE}/v1/actions/{action_id}/result", headers=HEADERS,
                  json={"status": "executed"})
    return output


def _execute(cmd: str) -> str:
    proc = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=120)
    return proc.stdout + proc.stderr
```

Point your agent framework's shell/bash tool at `run_command` instead of calling `subprocess` directly. The agent still decides *what* command to propose; `run_command` decides whether it's ever handed to a real shell.

---

## Why an allowlist plus a gate, not just a gate

Gating literally every command — including `ls` and `git status` — turns an autonomous agent back into a chat window where a human clicks approve every few seconds, which defeats the point of automation and trains reviewers to rubber-stamp without reading. `SAFE_PREFIXES` above keeps read-only, non-destructive commands flowing without interruption and reserves the human's attention for commands that mutate state: writes, deletes, pushes, publishes, `sudo`, package installs.

Tune the split for your repo. A reasonable rule: if the command can be undone by re-running a read, it's safe; if it changes something outside the working directory (a remote, a registry, a running process), gate it.

| Command pattern | Treatment |
|---|---|
| `git diff`, `git log`, `cat`, `ls`, `pytest` | Execute immediately |
| `git commit`, `git checkout -b` | Usually safe to allowlist too — local, reversible |
| `git push`, `git push --force` | Gate — affects shared state |
| `rm`, `rm -rf` | Gate — irreversible |
| `npm publish`, `pip upload`, `docker push` | Gate — irreversible and public |

---

## Add `undo` and `idempotent` hints for the reviewer

Because the reviewer only sees a bare command string, give them the context that's normally in the agent's head. Set `idempotent: false` for anything with a side effect and describe the rollback in `undo` — both are optional fields on `POST /v1/actions` and show up directly on the approval card:

```bash
curl -X POST https://api.impri.dev/v1/actions \
  -H "Authorization: Bearer $IMPRI_API_KEY" \
  -d '{
    "kind": "shell.execute",
    "title": "Run command: git push --force origin feature/cleanup",
    "preview": { "format": "plain", "body": "git push --force origin feature/cleanup" },
    "idempotent": false,
    "undo": "git push --force origin <previous-sha>:feature/cleanup"
  }'
```

A reviewer who sees "not idempotent, here's the undo" makes a faster and better-informed call than one staring at a bare command.

---

## The boundary: Impri doesn't understand shell syntax

Impri stores the command text, shows it to a human, and reports back a decision — it does not parse, sandbox, or validate the command itself. It can't tell you that `rm -rf $DIR` is dangerous if `$DIR` was empty and expanded to `/`; that's still the reviewer's job when they read the card, and your agent's job to interpolate variables into the preview text *before* submission so the reviewer sees the literal command, not a template. Impri is also only a real gate if `run_command` is the agent's only route to a shell — if the framework exposes a second raw exec tool, the wrapper above can be routed around.

For agents built specifically on the Claude Agent SDK, see [the Claude Agent SDK approval guide](human-approval-claude-agent-sdk.md), which covers the same pattern using that SDK's hook points.

---

## Next step

Read the [quickstart](quickstart.md) for getting an API key, then [rules](rules.md) if you want per-project routing (e.g. staging repo commands auto-approve, production repo commands always page you).
