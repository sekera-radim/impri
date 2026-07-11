/**
 * Claude Agent SDK tool wrapper.
 *
 * Gates a Claude Agent SDK tool_use block behind an Impri human-approval step.
 * When Claude calls a tool, the agent intercepts the tool_use block and passes
 * it through this wrapper before executing any side-effecting code.
 *
 * This module intentionally defines its own minimal interfaces for the Anthropic
 * tool format so that callers are not required to import from @anthropic-ai/sdk
 * for these types — they are structurally compatible.
 */

import type { ImpriClient } from "./client.js";
import { ImpriRejected } from "./errors.js";
import type { Preview } from "./types.js";

// ─── Minimal Anthropic SDK type shapes (structurally compatible) ──────────────

/** Tool definition in the Anthropic messages API format. */
export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

/** A tool_use content block returned by the Anthropic messages API. */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// ─── Gated tool ───────────────────────────────────────────────────────────────

export type ToolExecutor<T = unknown> = (input: Record<string, unknown>) => Promise<T>;

export interface GatedToolOptions<T = unknown> {
  /** The Anthropic tool definition to pass to client.messages.create({ tools: [...] }). */
  toolDef: AnthropicTool;
  /** Function that executes the tool after approval — receives (possibly edited) input. */
  execute: ToolExecutor<T>;
  /** Impri client instance. */
  impriClient: ImpriClient;
  /** Free-form kind label for the inbox (e.g. 'email.send', 'db.exec'). */
  kind: string;
  /**
   * Title shown in the human inbox.
   * Accepts a static string or a function that receives the tool's input object.
   */
  title: string | ((input: Record<string, unknown>) => string);
  /**
   * Preview content shown to the reviewer.
   * Accepts a static Preview or a function that receives the tool's input object.
   * Defaults to rendering the full input as a JSON plain-text preview.
   */
  preview?: Preview | ((input: Record<string, unknown>) => Preview);
  /** Dot-path field list the reviewer may modify before approving, e.g. ['preview.body']. */
  editable?: string[];
  /** Approval timeout in seconds. Default 300. */
  timeoutS?: number;
  /**
   * Called when the human rejects the action.
   * Return a string to feed back to Claude as the tool result.
   * Default: returns a clear rejection message.
   */
  onRejected?: (err: ImpriRejected) => string;
}

export interface GatedTool<T = unknown> {
  /**
   * Pass this to Anthropic's client.messages.create({ tools: [gated.toolDef] }).
   * It is identical to the original toolDef — unchanged so Claude behaves normally.
   */
  toolDef: AnthropicTool;
  /**
   * Call this for each tool_use block whose name matches this tool.
   *
   * Internally it:
   *   1. Submits the proposed call to Impri for approval.
   *   2. Waits for a human decision (blocks until approved, rejected, or timed out).
   *   3. On approval: calls execute(input) with possibly human-edited input.
   *   4. Reports the result to Impri.
   *   5. On rejection: returns the rejection message without calling execute.
   *
   * Returns a string suitable for use as tool_result content to feed back to Claude.
   */
  handle: (block: ToolUseBlock) => Promise<string>;
  /** The resolved executor for testing or manual invocation. */
  execute: ToolExecutor<T>;
}

/**
 * Wrap a Claude Agent SDK tool with an Impri human-approval gate.
 *
 * @example
 * const sendEmailGated = withImpriApproval({
 *   toolDef: {
 *     name: 'send_email',
 *     description: 'Send an email to a recipient.',
 *     input_schema: {
 *       type: 'object',
 *       properties: {
 *         to: { type: 'string' },
 *         body: { type: 'string' },
 *       },
 *       required: ['to', 'body'],
 *     },
 *   },
 *   execute: async ({ to, body }) => {
 *     await emailService.send({ to: String(to), body: String(body) });
 *     return `Email sent to ${to}`;
 *   },
 *   impriClient: impri,
 *   kind: 'email.send',
 *   title: ({ to }) => `Send email to ${to}`,
 *   preview: ({ body }) => ({ format: 'plain', body: String(body) }),
 *   editable: ['preview.body'],
 * });
 *
 * // In your agent loop:
 * const toolResultContent = await sendEmailGated.handle(toolUseBlock);
 */
export function withImpriApproval<T = unknown>(
  opts: GatedToolOptions<T>,
): GatedTool<T> {
  const {
    toolDef,
    execute,
    impriClient,
    kind,
    title,
    preview,
    editable,
    timeoutS,
    onRejected,
  } = opts;

  async function handle(block: ToolUseBlock): Promise<string> {
    const input = block.input;

    const resolvedTitle =
      typeof title === "function" ? title(input) : title;

    const resolvedPreview: Preview =
      preview === undefined
        ? { format: "plain", body: JSON.stringify(input, null, 2) }
        : typeof preview === "function"
          ? preview(input)
          : preview;

    let approved;
    try {
      const created = await impriClient.createAction({
        kind,
        title: resolvedTitle,
        preview: resolvedPreview,
        payload: { tool_use_id: block.id, tool_name: block.name, input },
        ...(editable && { editable }),
      });

      approved = await impriClient.awaitDecision(created.id, { timeoutS });
    } catch (err) {
      if (err instanceof ImpriRejected) {
        const handler =
          onRejected ??
          ((e: ImpriRejected) =>
            `Action rejected by human reviewer (action ${e.actionId}). The tool was not executed.`);
        return handler(err);
      }
      // ImpriTimeout, ImpriExpired, network errors — surface to the caller.
      throw err;
    }

    // When the reviewer edited preview.body, inject the human-edited value.
    const effectiveInput = mergeEditedPreview(input, approved.finalPreview, resolvedPreview);

    let resultText: string;
    try {
      const output = await execute(effectiveInput);
      resultText =
        typeof output === "string"
          ? output
          : JSON.stringify(output, null, 2);
      await impriClient.reportResult(approved.actionId, { status: "executed" });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await impriClient.reportResult(approved.actionId, {
        status: "execute_failed",
        detail,
      });
      throw err;
    }

    return resultText;
  }

  return { toolDef, handle, execute };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * When the reviewer changed preview.body and the input has a 'body' key,
 * replace it with the human-edited value so the executor gets the final text.
 */
function mergeEditedPreview(
  input: Record<string, unknown>,
  finalPreview: Preview,
  originalPreview: Preview,
): Record<string, unknown> {
  if (finalPreview.body === originalPreview.body) return input;

  if ("body" in input) {
    return { ...input, body: finalPreview.body };
  }

  return input;
}

/**
 * Build the tool_result message param to return to the Anthropic API.
 * Convenience helper for callers building their message history manually.
 */
export function makeToolResult(
  toolUseId: string,
  content: string,
  isError = false,
): {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
} {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content,
    ...(isError ? { is_error: true } : {}),
  };
}
