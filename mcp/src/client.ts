export interface SignoffConfig {
  apiKey: string;
  baseUrl: string;
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

export interface Action {
  id: string;
  kind: string;
  title: string;
  status: ActionStatus;
  inbox_url: string;
  preview?: { format: string; body: string };
  payload?: unknown;
  decision_at?: string;
  editable?: string[];
}

export async function apiRequest<T>(
  config: SignoffConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
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

  const res = await fetch(url, init);

  if (!res.ok) {
    return throwApiError(res);
  }

  if (res.status === 204) {
    return {} as T;
  }

  return res.json() as Promise<T>;
}

async function throwApiError(res: Response): Promise<never> {
  let detail = "";
  try {
    const body = (await res.json()) as { message?: string; error?: string };
    detail = body.message ?? body.error ?? "";
  } catch {
    detail = res.statusText;
  }

  switch (res.status) {
    case 401:
    case 403:
      throw new Error(
        "Authentication failed — verify your SIGNOFF_API_KEY is correct and has the required scope.",
      );
    case 404:
      throw new Error(
        "Resource not found — verify the action_id is correct and belongs to this API key.",
      );
    case 409:
      throw new Error(
        "Conflict — an action with this idempotency_key already exists; use signoff_await_decision to check its status.",
      );
    case 410:
      throw new Error(
        "Action expired — the approval window has closed. Create a new action with signoff_push_action if the task is still relevant.",
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
        `Signoff API error ${res.status}: ${detail || res.statusText}`,
      );
  }
}
