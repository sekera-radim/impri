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
  type ToolResult,
} from "./tools.js";

export interface ToolCallContent {
  type: "text";
  text: string;
}

export interface ToolCallResult {
  content: ToolCallContent[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  // Index signature so this structurally satisfies the MCP SDK's broader
  // CallToolResult/ServerResult union (which has optional fields like `task`
  // for other response shapes we don't use) when returned through a named
  // type instead of an inline literal.
  [key: string]: unknown;
}

// Shared by every case below: turns a tools.ts ToolResult into the MCP
// CallToolResult shape, carrying structuredContent through untouched when
// the tool set one (see each TOOLS entry's outputSchema comment in
// toolDefs.ts for which results do).
function toCallResult(result: ToolResult): ToolCallResult {
  return {
    content: [{ type: "text", text: result.text }],
    ...(result.isError ? { isError: true } : {}),
    ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
  };
}

/**
 * Executes one of the 8 Impri tools given raw JSON-RPC-style arguments.
 * Shared by the stdio server (mcp/src/index.ts) and the hosted streamable-HTTP
 * endpoint (server/src/routes/mcp.ts) so the name → typed-args → REST-call
 * mapping exists exactly once regardless of transport.
 */
export async function callTool(
  config: ImpriConfig,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
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
        return toCallResult(result);
      }

      case "impri_await_decision": {
        const result = await awaitDecision(config, {
          action_id: args["action_id"] as string,
          timeout_s: args["timeout_s"] as number | undefined,
        });
        return toCallResult(result);
      }

      case "impri_report_result": {
        const result = await reportResult(config, {
          action_id: args["action_id"] as string,
          status: args["status"] as "executed" | "execute_failed",
          detail: args["detail"] as string | undefined,
        });
        return toCallResult(result);
      }

      case "impri_inbox_status": {
        const result = await inboxStatus(config);
        return toCallResult(result);
      }

      case "impri_create_watcher": {
        const result = await createWatcher(config, { spec: args["spec"] });
        return toCallResult(result);
      }

      case "impri_list_watchers": {
        const result = await listWatchers(config, { status: args["status"] as string | undefined });
        return toCallResult(result);
      }

      case "impri_list_watcher_presets": {
        const result = await listWatcherPresets(config);
        return toCallResult(result);
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
        return toCallResult(result);
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}
