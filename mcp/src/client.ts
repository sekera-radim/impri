/**
 * A transport swaps out the network hop for an in-process call — used by the
 * server's own /mcp endpoint to execute tools against its Fastify routes
 * directly (via `app.inject`) instead of making a real HTTP request back to
 * itself. Shape mirrors just enough of `Response` for `apiRequest` below.
 */
export interface TransportResponse {
  status: number;
  json: () => Promise<unknown>;
}

export type Transport = (method: string, path: string, body?: unknown) => Promise<TransportResponse>;

export interface ImpriConfig {
  apiKey: string;
  baseUrl: string;
  /** Optional in-process transport. When set, `baseUrl`/`fetch` are not used. */
  transport?: Transport;
}

export interface ActionCreated {
  id: string;
  status: "pending";
  inbox_url: string;
}

export type ActionStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "executed"
  | "execute_failed";

export interface ActionDecision {
  verdict: "approve" | "reject";
  decided_at: number;
  channel?: string;
  /** Human-edited preview — present only when the reviewer used edit-before-approve. */
  final_preview?: { format: string; body: string };
  /** Unified-style diff against the original; present when final_preview differs. */
  diff?: string;
}

export interface Action {
  id: string;
  kind: string;
  title: string;
  status: ActionStatus;
  inbox_url: string;
  preview?: { format: string; body: string };
  payload?: unknown;
  editable?: string[];
  /** Populated by GET /v1/actions/:id once a human decision has been recorded. */
  decision?: ActionDecision;
}

export async function apiRequest<T>(
  config: ImpriConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res: TransportResponse;

  if (config.transport) {
    res = await config.transport(method, path, body);
  } else {
    const url = `${config.baseUrl}/v1${path}`;
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const fetchRes = await fetch(url, init);
    res = { status: fetchRes.status, json: () => fetchRes.json() };
  }

  if (res.status < 200 || res.status >= 300) {
    return throwApiError(res);
  }

  if (res.status === 204) {
    return {} as T;
  }

  return res.json() as Promise<T>;
}

async function throwApiError(res: TransportResponse): Promise<never> {
  let detail = "";
  try {
    const body = (await res.json()) as { message?: string; error?: string };
    detail = body.message ?? body.error ?? "";
  } catch {
    detail = "";
  }

  switch (res.status) {
    case 401:
    case 403:
      throw new Error(
        "Authentication failed — verify your IMPRI_API_KEY is correct and has the required scope.",
      );
    case 404:
      throw new Error(
        "Resource not found — verify the action_id is correct and belongs to this API key.",
      );
    case 409:
      throw new Error(
        "Conflict — an action with this idempotency_key already exists; use impri_await_decision to check its status.",
      );
    case 410:
      throw new Error(
        "Action expired — the approval window has closed. Create a new action with impri_push_action if the task is still relevant.",
      );
    case 422:
      throw new Error(
        `Invalid request: ${detail || "check the parameters and try again."}`,
      );
    case 429:
      throw new Error(
        "Rate limit reached — wait a moment and retry. Consider reducing request frequency.",
      );
    default:
      throw new Error(
        `Impri API error ${res.status}${detail ? `: ${detail}` : ""}`,
      );
  }
}
