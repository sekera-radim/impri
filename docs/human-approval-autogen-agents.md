# Human Approval for Microsoft AutoGen Agents

AutoGen agents can run the shell commands they write, on their own — add a human approval gate so nothing touches a real server until you say yes.

---

## AutoGen executes code by default

AutoGen's `UserProxyAgent` is built to run whatever code the assistant agent writes — that is the entire point of the pattern AutoGen popularized. Point it at a `LocalCommandLineCodeExecutor` (or the older `code_execution_config` dict) and generated Python or shell blocks run the moment the assistant emits them, with no pause in between.

That is fine in a sandbox. It stops being fine once the executor has a real path to a database, a production server, or a payments API. A hallucinated `DROP TABLE` or a shell one-liner with a wrong flag executes exactly as fast as a correct one.

AutoGen ships a softer control, `human_input_mode="ALWAYS"`, which pauses the chat and asks for input at the terminal. That works only for whoever is sitting there at that moment — it does nothing for an agent kicked off from a cron job or a pipeline where nobody is watching.

---

## Gate the executor, not the agent

The fix is to stop letting AutoGen auto-execute code at all, and instead give the assistant a single function tool that proposes a command, waits for a human decision through Impri, and only then runs it.

```python
import os, subprocess, time, requests

IMPRI = "https://api.impri.dev"
H = {"Authorization": f"Bearer {os.environ['IMPRI_API_KEY']}", "Content-Type": "application/json"}

def propose_and_run_shell(command: str, purpose: str) -> str:
    """Propose a shell command for human approval, then run it if approved."""
    action = requests.post(f"{IMPRI}/v1/actions", headers=H, json={
        "kind": "code.execute",
        "title": f"Run: {command[:60]}",
        "preview": {"format": "markdown", "body": f"**Purpose:** {purpose}\n\n```bash\n{command}\n```"},
        "expires_in": 1800,
        "idempotent": False,
        "undo": "No automatic rollback -- review the command's effect before approving.",
    }).json()

    while True:
        state = requests.get(f"{IMPRI}/v1/actions/{action['id']}", headers=H).json()
        if state["status"] != "pending":
            break
        time.sleep(10)

    if state["status"] != "approved":
        return f"Not run -- human {state['status']} the command."

    result = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=120)

    requests.post(f"{IMPRI}/v1/actions/{action['id']}/result", headers=H, json={
        "status": "executed" if result.returncode == 0 else "execute_failed",
        "payload": {"exit_code": result.returncode, "stdout": result.stdout[-2000:]},
    })
    return result.stdout or f"Command exited {result.returncode}"
```

Note there is no `editable` field here. A shell command is not something you want a reviewer casually rewriting in a text box — they approve exactly what was proposed, or they reject it and the agent has to propose something else. Free-text edits are the right call for an email body; they are the wrong call for a command line.

---

## Wiring it into the agents

Disable AutoGen's built-in executor entirely on the `UserProxyAgent` and register the gated function as the only way to run anything:

```python
from autogen import ConversableAgent, UserProxyAgent, register_function

assistant = ConversableAgent(
    name="ops_assistant",
    system_message=(
        "You help operate the staging server. To run any shell command, call "
        "propose_and_run_shell -- never assume a command has run until the "
        "function returns its output."
    ),
    llm_config={"config_list": [{"model": "gpt-4o", "api_key": os.environ["OPENAI_API_KEY"]}]},
)

executor = UserProxyAgent(
    name="executor",
    human_input_mode="NEVER",
    code_execution_config=False,  # AutoGen never auto-runs a generated code block
)

register_function(
    propose_and_run_shell,
    caller=assistant,
    executor=executor,
    description="Propose a shell command for human approval, then run it if approved.",
)

executor.initiate_chat(assistant, message="Restart the staging worker and confirm it's healthy.")
```

With `code_execution_config=False`, a code block the assistant writes into the chat transcript is inert text. The only executable path left is `propose_and_run_shell`, which is exactly the function that goes through Impri first.

---

## Marking risky commands honestly

Two of the optional fields on `POST /v1/actions` exist for exactly this scenario. `idempotent: false` tells the reviewer that approving the same command twice is not safe — the inbox card shows a warning badge instead of staying silent about it. `undo` is a plain-English note on how to walk the change back if it turns out to be wrong; for commands with no clean undo, saying so directly ("no automatic rollback") is more honest than leaving the field blank.

---

## How this compares to `human_input_mode`

| | AutoGen's `human_input_mode` | The Impri gate |
|---|---|---|
| Where approval happens | The terminal running the chat, synchronously | Any device — inbox, Slack, Telegram, email |
| Works when nobody is watching | No | Yes, `expires_in` holds the proposal open |
| Audit record | No | Who approved, rejected, or edited, and when |
| Granularity | Whole-chat setting | Per command — gate only the calls that need it |

The two are not mutually exclusive. Keep `human_input_mode="NEVER"` for unattended runs and rely on the function-level gate for side effects; turn it back on for interactive debugging where you are already watching the terminal.

---

## What Impri does and doesn't do

Impri stores the proposed command, notifies you, and holds the decision — it does not read the command, judge whether it is safe, or run it. That last part is still `subprocess.run` in your own code, gated on `status == "approved"`. The gate only holds if `propose_and_run_shell` is genuinely the agent's only way to reach a shell; leave a second, ungated code executor configured anywhere in the same chat and this becomes decorative.

---

## Next step

Start with the [quickstart](quickstart.md) for an API key with the `actions` scope, read [how to add human approval to an AI agent](how-to-add-human-approval-to-an-ai-agent.md) for the full propose → approve → execute contract, and use the [Python SDK](sdk-python.md) instead of raw `requests` calls once this moves past a prototype.
