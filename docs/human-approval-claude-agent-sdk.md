# Claude Agent SDK Human Approval: canUseTool and defer

The Claude Agent SDK asks your canUseTool callback before a risky tool call, or ends the turn when a hook defers it. Send either to Impri and a person decides.

---

## Where the SDK asks for permission

When Claude wants a tool, Claude Code checks the call in a fixed order: `PreToolUse` hooks, deny rules, ask rules, the permission mode, allow rules, and only then your `canUseTool` callback ([permissions docs](https://code.claude.com/docs/en/agent-sdk/permissions)). A call settled earlier never reaches the callback: a bare tool name in `allowedTools` such as `"Bash"`, file edits under `acceptEdits`, nearly everything under `bypassPermissions`, and read-only commands like `ls`. List routine commands as scoped rules (`"Bash(npm test *)"`) and let the callback see the rest. Which of the two places below fits depends on whether your process can wait.

## Option 1: wait inside `canUseTool`

```typescript
import { query, type CanUseTool, type HookCallback } from "@anthropic-ai/claude-agent-sdk";

const IMPRI = process.env.IMPRI_BASE_URL ?? "https://api.impri.dev";
const headers = {
  Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
  "Content-Type": "application/json",
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cards = new Map<string, string>(); // tool_use id -> Impri action id

const askImpri: CanUseTool = async (toolName, input, { signal, toolUseID }) => {
  if (toolName !== "Bash") {
    return { behavior: "deny", message: `${toolName} is not enabled for this agent.` };
  }
  const command = String(input.command);
  const res = await fetch(`${IMPRI}/v1/actions`, {
    method: "POST", headers, signal,
    body: JSON.stringify({
      kind: "shell.exec",
      title: `Run: ${command.replace(/\s+/g, " ").slice(0, 80)}`,
      preview: { format: "plain", body: command },
      editable: ["preview.body"],
      idempotency_key: toolUseID,
      expires_in: 1800,
    }),
  });
  if (!res.ok) return { behavior: "deny", message: `Approval inbox unavailable (${res.status}).` };
  const { id } = await res.json();
  cards.set(toolUseID, id);

  for (;;) {
    const action = await (await fetch(`${IMPRI}/v1/actions/${id}`, { headers, signal })).json();
    if (action.status === "approved") {
      // The reviewer may have edited the command before approving.
      return { behavior: "allow", updatedInput: { ...input, command: action.decision.final_preview.body } };
    }
    if (action.status !== "pending") {
      return { behavior: "deny", message: `Not run: the reviewer's answer was "${action.status}".` };
    }
    await sleep(3000);
  }
};

// Close the card with what actually happened.
const report: HookCallback = async (input, toolUseID) => {
  const id = toolUseID && cards.get(toolUseID);
  if (id && input.hook_event_name === "PostToolUse") {
    await fetch(`${IMPRI}/v1/actions/${id}/result`, {
      method: "POST", headers,
      body: JSON.stringify({ status: "executed", detail: JSON.stringify(input.tool_response).slice(0, 2000) }),
    });
  }
  return {};
};

for await (const message of query({
  prompt: "Tag the release and deploy it to staging.",
  options: {
    canUseTool: askImpri,
    allowedTools: ["Bash(npm test *)"], // routine commands skip the inbox
    hooks: { PostToolUse: [{ matcher: "Bash", hooks: [report] }] },
  },
})) {
  if (message.type === "result") console.log(message.subtype, message.stop_reason);
}
```

Each call that needs permission becomes a card in Impri with the exact command as an editable preview. The tool use ID is the idempotency key, so a retried request finds the same card. The callback polls until someone answers:

- **Approved**: the callback returns `allow` with `updatedInput`. If the reviewer edited the command, the edited one runs. Claude isn't told it changed; it only sees the output.
- **Rejected or expired**: `deny` with a message, which Claude reads as the tool's error.
- **Impri unreachable**: a denial. The SDK also turned an error thrown inside the callback into a denial.

The `PostToolUse` hook reports `executed`, so the card shows what ran. The callback may stay pending as long as it needs. Python works the same way with `can_use_tool` and `PermissionResultAllow(updated_input=...)`, but needs streaming input and a dummy `PreToolUse` hook that keeps the stream open ([user input docs](https://code.claude.com/docs/en/agent-sdk/user-input)).

## Option 2: let the process exit with `defer`

When the answer may take hours, don't hold a process open. A `PreToolUse` hook can return `defer`: the tool doesn't run, the turn ends with a result whose `stop_reason` is `tool_deferred`, and the session stays on disk, 30 days by default ([hooks docs](https://code.claude.com/docs/en/hooks#defer-a-tool-call-for-later)). On resume, Claude Code sends the same call through the hook again, and this time the hook finds a decision.

```typescript
import { query, type HookCallback, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

const IMPRI = process.env.IMPRI_BASE_URL ?? "https://api.impri.dev";
const headers = {
  Authorization: `Bearer ${process.env.IMPRI_API_KEY}`,
  "Content-Type": "application/json",
};
const RISKY = /^\s*(git push|kubectl|terraform apply|helm|\.\/deploy)/;

let busy = false; // a deferred turn can carry only one pending call

const gate: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  const toolInput = input.tool_input as { command: string };
  if (!RISKY.test(toolInput.command)) return {}; // normal permission flow
  const decide = (permissionDecision: "allow" | "deny" | "defer", extra = {}) => ({
    hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision, ...extra },
  });
  if (busy) {
    return decide("deny", { permissionDecisionReason: "Another command is waiting for approval. Run one risky command at a time." });
  }
  busy = true;

  try {
    // The resumed session replays the same tool call, so the same idempotency
    // key finds the same card instead of creating a second one.
    const created = await fetch(`${IMPRI}/v1/actions`, {
      method: "POST", headers,
      body: JSON.stringify({
        kind: "shell.exec",
        title: `Run: ${toolInput.command.replace(/\s+/g, " ").slice(0, 80)}`,
        preview: { format: "plain", body: toolInput.command },
        editable: ["preview.body"],
        idempotency_key: input.tool_use_id,
        expires_in: 86400,
      }),
    });
    if (!created.ok) throw new Error(`HTTP ${created.status}`);
    const { id } = await created.json();
    const action = await (await fetch(`${IMPRI}/v1/actions/${id}`, { headers })).json();

    if (action.status === "pending") return decide("defer");
    busy = false;
    if (action.status === "approved") {
      return decide("allow", { updatedInput: { ...toolInput, command: action.decision.final_preview.body } });
    }
    return decide("deny", { permissionDecisionReason: `Not run: the reviewer's answer was "${action.status}".` });
  } catch (err) {
    busy = false; // fail closed, whatever the permission mode
    return decide("deny", { permissionDecisionReason: `Not run: approval inbox unreachable (${err}).` });
  }
};

// `start`: run until a risky call waits for review, save the session, exit.
// `resume`: run after the decision; Claude Code checks the same call again.
// Resume with no new message, and keep the input open until the result:
// a prompt (even "") or a closed input makes Claude Code drop the pending call.
let done!: () => void;
const finished = new Promise<void>((resolve) => (done = resolve));
async function* noNewMessage(): AsyncGenerator<SDKUserMessage> { await finished; }

const resume = process.argv[2] === "resume" ? readFileSync("session.txt", "utf8") : undefined;
for await (const message of query({
  prompt: resume ? noNewMessage() : "Tag the release and deploy it to staging.",
  options: { resume, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [gate] }] } },
})) {
  if (message.type !== "result") continue;
  if (message.stop_reason === "tool_deferred") writeFileSync("session.txt", message.session_id);
  else rmSync("session.txt", { force: true });
  console.log(message.subtype, message.stop_reason);
  done();
}
```

Run `start` from your job and `resume` once the card is decided, for example from Impri's webhook: add a `callback_url` and Impri posts to it on approval, rejection or expiry ([webhooks](webhooks.md)). Three details come from runs that went wrong:

- **Resume with no new message, and keep the input open until the result.** With `prompt: ""`, or an empty input stream that closed at once, the pending call got an error result ("The user doesn't want to take this action right now") without the hook being called, and the call was gone. With the input held open, Claude Code ran the hook again for the same tool use ID.
- **One pending call per turn.** The hooks docs say `defer` is honored only for a single tool call in a turn and ignored otherwise. In our run it wasn't ignored: two risky calls in one assistant message both got cards and the turn ended deferred, but after we approved both, only one ran and the other disappeared from the transcript without a result. The `busy` flag denies the second call with a reason Claude can act on.
- **Fail closed in the hook.** A hook that throws makes no decision. In the default mode the call was then denied, but under `bypassPermissions`, with Impri stopped, the deploy ran. The `catch` makes any error a denial.

Pass the same options on every resume: Claude Code doesn't restore a stored permission mode.

## What we ran

On 2026-11-19, with `@anthropic-ai/claude-agent-sdk` 0.3.328 (Claude Code 2.1.328) against a local Impri server. The model was a local stand-in for the Messages API returning scripted `Bash` calls; the SDK, Claude Code and its permission flow were real. Every `start` and `resume` was a separate process.

| Scenario | What ran | What Claude got back | Card |
|---|---|---|---|
| Option 1, approved with an edit | the edited command | the command's output | `executed` |
| Option 1, rejected | nothing | `Not run: the reviewer's answer was "rejected".` | `rejected` |
| Option 1, `npm test` under the allow rule | `npm test` | its output | none created |
| Option 2, resumed while pending | nothing | nothing yet: the turn deferred again | same card, `pending` |
| Option 2, approved with an edit, then resumed | the edited command | the command's output | `approved` |
| Option 2, rejected, then resumed | nothing | the reason, prefixed `PreToolUse:Bash hook error:` | `rejected` |
| Impri unreachable, either option | nothing | a denial | none |

Option 2 leaves the card at `approved`; add the `PostToolUse` report from Option 1 to mark it `executed`.

## Which one to use

Option 1 when the agent's process stays up during the review. Option 2 for jobs, serverless functions and anything that restarts: nothing waits in memory, and the reviewer can answer the next morning. An agent key needs only the `actions` scope; `POST /v1/actions` allows 60 requests per minute per key. Impri holds the decision and never runs the command: Claude Code does, and the gate covers only calls that reach your callback or hook.

## Next step

[Start free on Impri Cloud](https://app.impri.dev/?signup=1), create an API key and run Option 1 with a harmless command: the card appears in your inbox. To keep everything on your own machine, follow [Self-hosting](self-hosting.md) and set `IMPRI_BASE_URL=http://localhost:8484`. On the Anthropic Messages API with your own tool loop instead of the Agent SDK? The [tool_use wrapper](claude-agent-sdk.md) gates each call there.
