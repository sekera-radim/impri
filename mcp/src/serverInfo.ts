import { createRequire } from "node:module";

// Shared server-level identity (MCP 2025-06-18 InitializeResult.serverInfo
// name/title/version, plus InitializeResult.instructions). Used by:
//   - mcp/src/index.ts        — the stdio server (npx @impri/mcp)
//   - server/src/routes/mcp.ts — the hosted streamable-HTTP /mcp endpoint
//   - server's .well-known/mcp/server-card.json
// Keeping these in one place means all three can never drift from each
// other, same reasoning as toolDefs.ts.

// Read from mcp/package.json, not server/package.json: this is the version
// MCP clients see in serverInfo.version and the server card, and it has to
// track @impri/mcp (the published stdio package + the shared tool
// definitions this hosted endpoint re-exports) — not @impri/server's own
// internal version, which is what used to leak in here (serverInfo reported
// server/package.json's 0.1.0 while @impri/mcp was already at 0.1.2).
const _require = createRequire(import.meta.url);
export const VERSION: string = (_require("../package.json") as { version: string }).version;

// Matches @impri/mcp's own package/npm identity (same convention
// @briefgate/mcp uses for its serverInfo.name) — nothing else depends on
// this string, but directories that have already indexed the server under
// this name would otherwise see it change for no behavioral reason.
export const SERVER_NAME = "@impri/mcp";
export const SERVER_TITLE = "Impri";

// MCP 2025-06-18 InitializeResult.instructions — surfaced to the model once
// per session (e.g. by `claude mcp add`), so a client can decide WHEN to
// reach for these tools without first reading every individual tool
// description. Plain and honest, not marketing copy: what Impri is for,
// when to use it, and the push/await/report loop.
export const INSTRUCTIONS = `
Impri is a human-in-the-loop approval inbox: before an irreversible or outward-facing action (sending a message, posting publicly, spending money, touching production), submit it with impri_push_action and wait for a person to approve, edit, or reject it. Use it for decisions only a human should make, not for questions the person in this conversation can already answer.

Flow: impri_push_action returns an action_id. Call impri_await_decision(action_id); "pending" after a timeout is normal — call it again. On "approved", use the returned preview/payload (it reflects any reviewer edits), carry out the action, then call impri_report_result with "executed" or "execute_failed". On "rejected", do not proceed.

impri_create_watcher and impri_create_watcher_from_preset set up watchers that feed matching items from external sources (RSS, Reddit, GitHub, URL diffs) into this same approval inbox.
`.trim();
