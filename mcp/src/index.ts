#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { type ImpriConfig } from "./client.js";
import {
  awaitDecision,
  createWatcher,
  createWatcherFromPreset,
  inboxStatus,
  listWatcherPresets,
  listWatchers,
  pushAction,
  reportResult,
} from "./tools.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const apiKey = process.env["IMPRI_API_KEY"];
if (!apiKey) {
  // Don't exit — start anyway so clients and registries (e.g. Glama) can
  // introspect the tool list before a key is configured. Tool *calls* return
  // a clear error until IMPRI_API_KEY is set (see the CallTool handler).
  process.stderr.write(
    [
      "Warning: IMPRI_API_KEY is not set — tool calls will fail until it is.",
      "Obtain an API key at https://impri.dev and pass it via environment variable.",
      "Example: IMPRI_API_KEY=im_... npx @impri/mcp",
    ].join("\n") + "\n",
  );
}

const config: ImpriConfig = {
  apiKey: apiKey ?? "",
  baseUrl: process.env["IMPRI_BASE_URL"] ?? "http://localhost:8484",
};

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "impri_push_action",
    description: `Submit an action to the Impri human-approval inbox.

The action appears in the operator's web and mobile inbox as a card with a title, formatted preview, and optional tap-to-edit fields. The operator approves or rejects with one tap; you poll for the decision with impri_await_decision.

Returns { action_id, status: "pending", inbox_url }. Save action_id — you need it for all follow-up calls.

Example — send a draft Reddit reply for review:
  kind: "reddit.comment"
  title: "Reply: Why is resume advice so conflicting?"
  preview: { format: "markdown", body: "The advice conflicts because different advisors optimise for different audiences..." }
  target_url: "https://reddit.com/r/cscareerquestions/comments/..."
  editable: ["preview.body"]   // lets the reviewer tweak wording before approving`,
    inputSchema: {
      type: "object" as const,
      properties: {
        kind: {
          type: "string",
          description:
            "Taxonomy label used for inbox filtering (e.g. 'reddit.comment', 'email.send', 'blog.publish'). Free-form; choose a consistent scheme.",
        },
        title: {
          type: "string",
          description: "Short headline shown in the inbox card. Keep it under 120 characters.",
        },
        preview: {
          type: "object",
          description: "The content the reviewer reads before deciding.",
          properties: {
            format: {
              type: "string",
              enum: ["markdown", "text"],
              description: "Render format for the preview body.",
            },
            body: {
              type: "string",
              description: "Full text of what you want the reviewer to approve.",
            },
          },
          required: ["format", "body"],
        },
        payload: {
          description:
            "Opaque data echoed back in the webhook callback — useful for storing context (e.g. Reddit post id, draft id, queue position). Not shown to the reviewer.",
        },
        target_url: {
          type: "string",
          description:
            "URL the reviewer can open for context (e.g. the Reddit thread, the email draft). Optional but strongly recommended.",
        },
        expires_in: {
          type: "number",
          description:
            "Seconds until the action auto-expires (default 86400 = 24 h). After expiry the status becomes 'expired' and no decision can be made.",
        },
        idempotency_key: {
          type: "string",
          description:
            "Stable key to prevent duplicate submissions on retry. The same key within 24 h returns the original action instead of creating a new one.",
        },
        editable: {
          type: "array",
          items: { type: "string" },
          description:
            "Dot-notation fields the reviewer may edit before approving (e.g. ['preview.body']). The final edited values are echoed back in the approved action.",
        },
      },
      required: ["kind", "title", "preview"],
    },
  },
  {
    name: "impri_await_decision",
    description: `Poll until the human approves, rejects, or the timeout elapses.

Checks GET /actions/:id every 5 seconds and returns as soon as the action leaves the pending state.

Decision meanings:
  "approved"  — proceed with the action; any reviewer edits are included in preview/payload
  "rejected"  — abort; respect the decision and do not proceed
  "expired"   — the approval window closed; create a new action if the task is still relevant

On timeout the action stays pending in the inbox. Call impri_inbox_status to check queue depth and consider pausing further submissions.

Typical usage:
  1. impri_push_action → get action_id
  2. impri_await_decision(action_id) → wait for human decision
  3. If approved: execute the action, then impri_report_result(action_id, "executed")`,
    inputSchema: {
      type: "object" as const,
      properties: {
        action_id: {
          type: "string",
          description: "The id returned by impri_push_action.",
        },
        timeout_s: {
          type: "number",
          description:
            "Maximum seconds to wait before returning (default 300 — 5 minutes). After timeout the action is still pending; retry or call impri_inbox_status.",
        },
      },
      required: ["action_id"],
    },
  },
  {
    name: "impri_report_result",
    description: `Report whether you successfully executed an approved action.

Closes the audit loop — the operator sees 'executed' or 'execute_failed' in the inbox alongside the original action and decision. Always call this after attempting an approved action, even on failure.

Statuses:
  "executed"       — action was carried out successfully
  "execute_failed" — execution attempt failed (include the error in detail)`,
    inputSchema: {
      type: "object" as const,
      properties: {
        action_id: {
          type: "string",
          description: "The id returned by impri_push_action.",
        },
        status: {
          type: "string",
          enum: ["executed", "execute_failed"],
          description: "Outcome of executing the approved action.",
        },
        detail: {
          type: "string",
          description:
            "Optional message — error description on failure, short confirmation on success.",
        },
      },
      required: ["action_id", "status"],
    },
  },
  {
    name: "impri_inbox_status",
    description: `Check how many actions are waiting for human decisions.

Returns the pending count and a brief list of pending action titles. Call this before starting a large batch of tasks — if the inbox is backed up, pause and let the operator catch up to avoid actions expiring before they are reviewed.`,
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "impri_create_watcher",
    description: `Create a watcher that monitors external sources (RSS feeds, Reddit, URL diffs) and delivers matching items to the approval inbox or a webhook.

The watcher runs on the schedule you specify, deduplicates items by URL/content-hash, and delivers only new matches. The first run establishes a baseline and does not generate alerts.

Example — watch an RSS feed for AI-related news:
  spec: {
    name: "AI launches radar",
    kind: "rss",
    config: { url: "https://openai.com/news/rss.xml" },
    keywords: ["launch", "gpt-", "voice"],
    keywords_none: ["funding", "benchmark"],
    min_score: 1,
    schedule: { every: "8h", jitter: "4h" }
  }

Returns { watcher_id, name, kind, status, next_run_at }.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        spec: {
          type: "object",
          description:
            "Watcher specification (name, kind, config, keywords, keywords_none, min_score, schedule). See SPEC.md §3.2 for the full schema.",
        },
      },
      required: ["spec"],
    },
  },
  {
    name: "impri_list_watchers",
    description: `List all configured watchers, optionally filtered by status.

Returns the watcher count and a summary line per watcher (id, name, kind, status). Use this to audit what is being monitored, check for degraded watchers, or find a watcher_id for further operations.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["active", "paused", "degraded"],
          description:
            "Filter watchers by status. Omit to return all watchers regardless of status.",
        },
      },
      required: [],
    },
  },
  {
    name: "impri_list_watcher_presets",
    description: `List all available watcher presets with their parameters.

Presets are pre-configured watcher templates for common sources (Hacker News, Reddit, GitHub, npm, YouTube, arXiv, etc.). Each preset has an id, a human-readable title, required and optional params, and a default schedule.

Call this first to discover which preset fits your monitoring goal, then use impri_create_watcher_from_preset to create the watcher by supplying only the preset_id and param values. No deep knowledge of watcher config schemas is needed.

Example output:
  Community:
    - hn-front-page: "Hacker News Front Page" (rss) — no params required
    - reddit-keyword: "Reddit – Keyword Search" (reddit_search) — params: query, [subreddit]`,
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "impri_create_watcher_from_preset",
    description: `Create a watcher from a preset template by supplying the preset id and param values.

Presets handle all watcher config construction — URL building, keyword setup, SSRF validation — so you only provide the param values listed by impri_list_watcher_presets.

The schedule defaults to the preset's recommended interval but can be overridden. The name defaults to "{preset title}: {primary param value}" if omitted.

Returns { watcher_id, name, kind, status, next_run_at }.

Examples:

  Watch the HN front page (no params needed):
    preset_id: "hn-front-page"
    params: {}

  Watch a subreddit for new posts:
    preset_id: "reddit-subreddit"
    params: { subreddit: "MachineLearning" }

  Watch a GitHub repo for new releases, check every 2 hours:
    preset_id: "github-releases"
    params: { owner: "fastify", repo: "fastify" }
    schedule: { every: "2h" }

  Watch HN for keyword with a custom min_points threshold:
    preset_id: "hn-keyword"
    params: { keyword: "rust programming", min_points: "25" }`,
    inputSchema: {
      type: "object" as const,
      properties: {
        preset_id: {
          type: "string",
          description:
            "Preset identifier from impri_list_watcher_presets (e.g. \"hn-front-page\", \"reddit-subreddit\", \"github-releases\").",
        },
        params: {
          type: "object",
          description:
            "Key/value map of param values as strings. Required params must be present; optional params may be omitted to use preset defaults.",
          additionalProperties: { type: "string" },
        },
        name: {
          type: "string",
          description:
            "Optional display name for the watcher. Defaults to \"{preset title}: {primary param value}\" when omitted.",
        },
        schedule: {
          type: "object",
          description:
            "Optional schedule override. Omit to use the preset's default schedule.",
          properties: {
            every: {
              type: "string",
              description:
                "Run interval in duration format (e.g. \"30m\", \"1h\", \"6h\", \"1d\"). Must be at least 60s; tier minimums apply.",
            },
            jitter: {
              type: "string",
              description:
                "Random delay added to each run to spread load (e.g. \"5m\"). Optional.",
            },
            window: {
              type: "string",
              description:
                "Active time window in HH:MM-HH:MM format (e.g. \"06:00-22:00\"). Runs outside the window are skipped. Optional.",
            },
          },
          required: [],
        },
      },
      required: ["preset_id", "params"],
    },
  },
];

// ─── MCP server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "@impri/mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  if (!apiKey) {
    return {
      content: [
        {
          type: "text" as const,
          text: "Error: IMPRI_API_KEY is not set. Get a key at https://impri.dev and set it in your MCP client config for this server.",
        },
      ],
      isError: true,
    };
  }

  try {
    switch (name) {
      case "impri_push_action": {
        const result = await pushAction(config, {
          kind: args["kind"] as string,
          title: args["title"] as string,
          preview: args["preview"] as { format: string; body: string },
          payload: args["payload"],
          target_url: args["target_url"] as string | undefined,
          expires_in: args["expires_in"] as number | undefined,
          idempotency_key: args["idempotency_key"] as string | undefined,
          editable: args["editable"] as string[] | undefined,
        });
        return {
          content: [{ type: "text" as const, text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        };
      }

      case "impri_await_decision": {
        const result = await awaitDecision(config, {
          action_id: args["action_id"] as string,
          timeout_s: args["timeout_s"] as number | undefined,
        });
        return {
          content: [{ type: "text" as const, text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        };
      }

      case "impri_report_result": {
        const result = await reportResult(config, {
          action_id: args["action_id"] as string,
          status: args["status"] as "executed" | "execute_failed",
          detail: args["detail"] as string | undefined,
        });
        return {
          content: [{ type: "text" as const, text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        };
      }

      case "impri_inbox_status": {
        const result = await inboxStatus(config);
        return {
          content: [{ type: "text" as const, text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        };
      }

      case "impri_create_watcher": {
        const result = await createWatcher(config, {
          spec: args["spec"],
        });
        return {
          content: [{ type: "text" as const, text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        };
      }

      case "impri_list_watchers": {
        const result = await listWatchers(config, {
          status: args["status"] as string | undefined,
        });
        return {
          content: [{ type: "text" as const, text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        };
      }

      case "impri_list_watcher_presets": {
        const result = await listWatcherPresets(config);
        return {
          content: [{ type: "text" as const, text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        };
      }

      case "impri_create_watcher_from_preset": {
        const result = await createWatcherFromPreset(config, {
          preset_id: args["preset_id"] as string,
          params: (args["params"] ?? {}) as Record<string, string>,
          name: args["name"] as string | undefined,
          schedule: args["schedule"] as
            | { every?: string; jitter?: string; window?: string }
            | undefined,
        });
        return {
          content: [{ type: "text" as const, text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        };
      }

      default:
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: message }],
      isError: true,
    };
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
