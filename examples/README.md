# Impri examples

## `approval-gated-agent.mjs`

A complete, dependency-free agent (Node 18+) that shows the core Impri loop:
it proposes an action, waits for you to approve or reject it in the Impri
inbox, and only runs the action if you approve — then reports the result back.

```bash
IMPRI_API_KEY=im_your_key \
IMPRI_BASE_URL=https://api.impri.dev \
node approval-gated-agent.mjs
```

- Get `IMPRI_API_KEY` from your Impri operator (it starts with `im_`).
- Use `IMPRI_BASE_URL=http://localhost:8484` for a local self-hosted server.

Edit the `task` object to change what the agent proposes, and replace
`performAction()` with the real thing you want gated behind human approval
(send an email, deploy, issue a refund, delete data, spend money, …).

### Prefer an LLM agent?

If your agent is an LLM (Claude and others), you usually don't write this loop
by hand — you give it the Impri MCP server so it can request approval as a
tool call:

```json
{
  "mcpServers": {
    "impri": {
      "command": "npx",
      "args": ["-y", "@impri/mcp"],
      "env": { "IMPRI_API_KEY": "im_your_key", "IMPRI_BASE_URL": "https://api.impri.dev" }
    }
  }
}
```
