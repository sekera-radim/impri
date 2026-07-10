import { apiRequest, type Action, type ActionCreated, type ImpriConfig } from "./client.js";

export interface ToolResult {
  text: string;
  isError?: boolean;
}

// ─── impri_push_action ────────────────────────────────────────────────────────

export interface PushActionArgs {
  kind: string;
  title: string;
  preview: { format: string; body: string };
  payload?: unknown;
  target_url?: string;
  expires_in?: number;
  idempotency_key?: string;
  editable?: string[];
}

export async function pushAction(
  config: ImpriConfig,
  args: PushActionArgs,
): Promise<ToolResult> {
  const result = await apiRequest<ActionCreated>(config, "POST", "/actions", args);
  return {
    text: JSON.stringify(
      {
        action_id: result.id,
        status: result.status,
        inbox_url: result.inbox_url,
      },
      null,
      2,
    ),
  };
}

// ─── impri_await_decision ─────────────────────────────────────────────────────

export interface AwaitDecisionArgs {
  action_id: string;
  timeout_s?: number;
}

export async function awaitDecision(
  config: ImpriConfig,
  args: AwaitDecisionArgs,
  pollIntervalMs = 5_000,
): Promise<ToolResult> {
  const timeoutS = args.timeout_s ?? 300;
  const deadline = Date.now() + timeoutS * 1000;

  while (true) {
    const action = await apiRequest<Action>(config, "GET", `/actions/${args.action_id}`);

    if (action.status !== "pending") {
      return formatDecision(action);
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        text: `Timed out after ${timeoutS}s waiting for action ${args.action_id}. It is still pending — use impri_inbox_status to check queue depth or open the inbox at https://impri.dev/inbox.`,
        isError: true,
      };
    }

    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(pollIntervalMs, remaining)),
    );
  }
}

function formatDecision(action: Action): ToolResult {
  if (action.status === "expired") {
    return {
      text: `Action ${action.id} has expired — the approval window closed. Create a new action with impri_push_action if the task is still relevant.`,
      isError: true,
    };
  }

  const decision = action.decision;
  // When the reviewer used edit-before-approve, final_preview carries the human-edited
  // text; diff is only present when a change was actually made.
  const effectivePreview = decision?.final_preview ?? action.preview;
  const editedByHuman = !!decision?.diff;

  return {
    text: JSON.stringify(
      {
        action_id: action.id,
        status: action.status,
        decision_at: decision?.decided_at,
        preview: effectivePreview,
        edited_by_human: editedByHuman,
        ...(decision?.diff ? { diff: decision.diff } : {}),
        payload: action.payload,
      },
      null,
      2,
    ),
  };
}

// ─── impri_report_result ──────────────────────────────────────────────────────

export interface ReportResultArgs {
  action_id: string;
  status: "executed" | "execute_failed";
  detail?: string;
}

export async function reportResult(
  config: ImpriConfig,
  args: ReportResultArgs,
): Promise<ToolResult> {
  await apiRequest(config, "POST", `/actions/${args.action_id}/result`, {
    status: args.status,
    ...(args.detail !== undefined && { detail: args.detail }),
  });

  const suffix = args.detail ? ` (${args.detail})` : "";
  return { text: `Result reported: action ${args.action_id} → ${args.status}${suffix}.` };
}

// ─── impri_inbox_status ───────────────────────────────────────────────────────

export async function inboxStatus(config: ImpriConfig): Promise<ToolResult> {
  // Server returns { items, has_more, next_cursor } — we fetch one page (default 50)
  const raw = await apiRequest<unknown>(config, "GET", "/actions?status=pending");

  let items: Action[];

  if (Array.isArray(raw)) {
    items = raw as Action[];
  } else {
    const resp = raw as { items?: Action[] };
    items = resp.items ?? [];
  }

  if (items.length === 0) {
    return { text: "Impri inbox: 0 pending actions. The inbox is clear — safe to start new tasks." };
  }

  const lines: string[] = [
    `Impri inbox: ${items.length} pending action${items.length === 1 ? "" : "s"} awaiting decision`,
  ];

  for (const item of items.slice(0, 10)) {
    lines.push(`  - ${item.id}: "${item.title}" (${item.kind})`);
  }

  if (items.length > 10) {
    lines.push(`  … and ${items.length - 10} more`);
  }

  return { text: lines.join("\n") };
}

// ─── Phase 2 stubs ────────────────────────────────────────────────────────────

export function createWatcher(): ToolResult {
  return {
    text: "Watchers are not yet available — they arrive in Impri phase 2. This tool exists so integrations can reference it without API changes when watchers ship. Use RSS/webhook integrations directly in the meantime.",
    isError: true,
  };
}

export function listWatchers(): ToolResult {
  return {
    text: "Watchers are not yet available — they arrive in Impri phase 2. This tool exists so integrations can reference it without API changes when watchers ship.",
    isError: true,
  };
}
