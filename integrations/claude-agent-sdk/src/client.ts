/**
 * ImpriClient — full Impri REST API client using native fetch.
 *
 * Provides all API methods (actions, watchers, keys, project) plus the
 * ergonomic helpers: requiresApproval (HOF) and approvalGate (inline gate).
 */

import { ImpriConfigError, ImpriExpired, ImpriRejected, ImpriTimeout } from "./errors.js";
import { apiRequest, type HttpConfig } from "./http.js";
import type {
  Action,
  ActionCreated,
  ActionStatus,
  ApiKey,
  ApiKeyCreated,
  ApprovalGateOpts,
  ApprovedAction,
  CreateActionParams,
  CreateWatcherParams,
  DecideParams,
  DecisionResult,
  ImpriClientConfig,
  KeyScope,
  ListActionsParams,
  ListWatchersParams,
  PagedResult,
  Preview,
  Project,
  ProjectExport,
  ReportResultParams,
  ResultAck,
  UpdateWatcherParams,
  Watcher,
} from "./types.js";

// ─── requiresApproval HOF types ───────────────────────────────────────────────

type MaybeFactory<T, Args extends unknown[]> = T | ((...args: Args) => T);

function resolve<T, Args extends unknown[]>(
  value: MaybeFactory<T, Args>,
  args: Args,
): T {
  return typeof value === "function"
    ? (value as (...args: Args) => T)(...args)
    : value;
}

export interface RequiresApprovalOpts<Args extends unknown[]> {
  kind: string;
  title: MaybeFactory<string, Args>;
  preview?: MaybeFactory<Preview, Args>;
  editable?: string[];
  /** Seconds to wait before raising ImpriTimeout. Default 300. */
  timeoutS?: number;
  /** Additional CreateActionParams fields forwarded as-is (payload, target_url, etc.). */
  [key: string]: unknown;
}

// ─── ImpriClient ─────────────────────────────────────────────────────────────

export class ImpriClient {
  private readonly cfg: HttpConfig;

  constructor(config: ImpriClientConfig = {}) {
    const apiKey =
      config.apiKey ??
      (typeof process !== "undefined" ? process.env["IMPRI_API_KEY"] : undefined);

    if (!apiKey) {
      throw new ImpriConfigError(
        "IMPRI_API_KEY is not set. Pass it as { apiKey } to ImpriClient or set the IMPRI_API_KEY environment variable.",
      );
    }

    const rawBase =
      config.baseUrl ??
      (typeof process !== "undefined" ? process.env["IMPRI_BASE_URL"] : undefined) ??
      "http://localhost:8484";

    this.cfg = {
      apiKey,
      // Tolerate a trailing slash on the base URL.
      baseUrl: rawBase.replace(/\/$/, ""),
    };
  }

  // ─── Actions ────────────────────────────────────────────────────────────────

  /** POST /v1/actions — submit an action for human approval. */
  async createAction(params: CreateActionParams): Promise<ActionCreated> {
    return apiRequest<ActionCreated>(this.cfg, "POST", "/actions", params);
  }

  /** GET /v1/actions/:id — fetch a single action with its current status. */
  async getAction(actionId: string): Promise<Action> {
    return apiRequest<Action>(this.cfg, "GET", `/actions/${actionId}`);
  }

  /** GET /v1/actions — list actions, newest first, cursor-paginated. */
  async listActions(params: ListActionsParams = {}): Promise<PagedResult<Action>> {
    const qs = buildQs({
      status: params.status,
      kind: params.kind,
      since: params.since?.toString(),
      limit: params.limit?.toString(),
      cursor: params.cursor,
    });
    return apiRequest<PagedResult<Action>>(this.cfg, "GET", `/actions${qs}`);
  }

  /** POST /v1/actions/:id/decision — approve or reject (primarily for programmatic use). */
  async decide(actionId: string, params: DecideParams): Promise<DecisionResult> {
    return apiRequest<DecisionResult>(
      this.cfg,
      "POST",
      `/actions/${actionId}/decision`,
      params,
    );
  }

  /** POST /v1/actions/:id/result — report execution outcome after approval. */
  async reportResult(actionId: string, params: ReportResultParams): Promise<ResultAck> {
    return apiRequest<ResultAck>(this.cfg, "POST", `/actions/${actionId}/result`, params);
  }

  /**
   * Polling convenience wrapper (not a separate HTTP endpoint).
   *
   * Polls GET /v1/actions/:id every pollIntervalMs milliseconds until status
   * leaves 'pending'. On 'approved' returns an ApprovedAction ready for
   * execution. Throws ImpriRejected, ImpriExpired, or ImpriTimeout as
   * documented in the spec.
   *
   * Always use decision.finalPreview for execution when editable fields were
   * set — it carries the human-edited content.
   *
   * Recommended polling floor: 5 s (300 req/min rate limit).
   */
  async awaitDecision(
    actionId: string,
    opts: { timeoutS?: number; pollIntervalMs?: number } = {},
  ): Promise<ApprovedAction> {
    const timeoutS = opts.timeoutS ?? 300;
    const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
    const deadline = Date.now() + timeoutS * 1_000;

    while (true) {
      const action = await this.getAction(actionId);

      if (action.status !== "pending") {
        return this.resolveDecision(action);
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new ImpriTimeout(actionId, timeoutS);
      }

      await sleep(Math.min(pollIntervalMs, remaining));
    }
  }

  private resolveDecision(action: Action): ApprovedAction {
    if (action.status === "expired") {
      throw new ImpriExpired(
        `Action ${action.id} expired — the approval window closed before a decision was made.`,
        action,
      );
    }

    const decision = action.decision;

    if (!decision || decision.verdict === "reject") {
      throw new ImpriRejected(
        action.id,
        decision,
        decision?.final_preview ?? action.preview,
      );
    }

    const finalPreview = decision.final_preview ?? action.preview;
    const isUntrusted =
      (action.payload as Record<string, unknown> | undefined)?.untrusted === true;

    return { actionId: action.id, decision, finalPreview, isUntrusted };
  }

  // ─── Watchers ───────────────────────────────────────────────────────────────

  /** POST /v1/watchers — create a monitoring watcher. */
  async createWatcher(params: CreateWatcherParams): Promise<Watcher> {
    return apiRequest<Watcher>(this.cfg, "POST", "/watchers", params);
  }

  /** GET /v1/watchers — list watchers, cursor-paginated. */
  async listWatchers(params: ListWatchersParams = {}): Promise<PagedResult<Watcher>> {
    const qs = buildQs({
      status: params.status,
      kind: params.kind,
      limit: params.limit?.toString(),
      cursor: params.cursor,
    });
    return apiRequest<PagedResult<Watcher>>(this.cfg, "GET", `/watchers${qs}`);
  }

  /** GET /v1/watchers/:id — get a watcher plus item_count. */
  async getWatcher(watcherId: string): Promise<Watcher & { item_count: number }> {
    return apiRequest<Watcher & { item_count: number }>(
      this.cfg,
      "GET",
      `/watchers/${watcherId}`,
    );
  }

  /** PATCH /v1/watchers/:id — partial update; only supplied fields change. */
  async updateWatcher(watcherId: string, params: UpdateWatcherParams): Promise<Watcher> {
    return apiRequest<Watcher>(this.cfg, "PATCH", `/watchers/${watcherId}`, params);
  }

  /** DELETE /v1/watchers/:id — permanently delete watcher and dedup state. */
  async deleteWatcher(watcherId: string): Promise<void> {
    await apiRequest<void>(this.cfg, "DELETE", `/watchers/${watcherId}`);
  }

  // ─── API keys ────────────────────────────────────────────────────────────────

  /** POST /v1/keys — create a new API key. Raw key returned once. */
  async createKey(name: string, scopes: KeyScope[]): Promise<ApiKeyCreated> {
    return apiRequest<ApiKeyCreated>(this.cfg, "POST", "/keys", { name, scopes });
  }

  /** GET /v1/keys — list all keys including revoked ones. */
  async listKeys(): Promise<ApiKey[]> {
    return apiRequest<ApiKey[]>(this.cfg, "GET", "/keys");
  }

  /** DELETE /v1/keys/:id — revoke a key; subsequent requests with that key fail 401. */
  async revokeKey(keyId: string): Promise<void> {
    await apiRequest<void>(this.cfg, "DELETE", `/keys/${keyId}`);
  }

  // ─── Project ─────────────────────────────────────────────────────────────────

  /** GET /v1/project — project metadata including webhook_secret. */
  async getProject(): Promise<Project> {
    return apiRequest<Project>(this.cfg, "GET", "/project");
  }

  /** PATCH /v1/project — update project name and/or IANA timezone. */
  async updateProject(params: { name?: string; timezone?: string }): Promise<Project> {
    return apiRequest<Project>(this.cfg, "PATCH", "/project", params);
  }

  /**
   * POST /v1/project/rotate-webhook-secret.
   * Immediately invalidates the old secret — update verification before rotating in production.
   */
  async rotateWebhookSecret(): Promise<{ webhook_secret: string; note: string }> {
    return apiRequest<{ webhook_secret: string; note: string }>(
      this.cfg,
      "POST",
      "/project/rotate-webhook-secret",
    );
  }

  /** GET /v1/project/export — full GDPR data export. */
  async exportProject(): Promise<ProjectExport> {
    return apiRequest<ProjectExport>(this.cfg, "GET", "/project/export");
  }

  /** DELETE /v1/project/data — GDPR erasure; irreversible. */
  async eraseProjectData(): Promise<{ erased: true; actions: number; watchers: number }> {
    return apiRequest<{ erased: true; actions: number; watchers: number }>(
      this.cfg,
      "DELETE",
      "/project/data",
    );
  }

  // ─── Ergonomic helpers ────────────────────────────────────────────────────────

  /**
   * Inline approval gate for one-off gating where no function wrapper fits.
   *
   * Creates an action, waits for decision, and returns the approved state.
   * You are responsible for calling reportResult afterwards.
   *
   * Throws ImpriRejected, ImpriExpired, or ImpriTimeout — handle them
   * before executing any side-effecting code.
   *
   * @example
   * const { actionId, finalPreview } = await client.approvalGate({
   *   kind: 'db.exec',
   *   title: 'DROP TABLE users',
   *   preview: { format: 'plain', body: sql },
   *   editable: ['preview.body'],
   * });
   * try {
   *   await db.execute(finalPreview.body);
   *   await client.reportResult(actionId, { status: 'executed' });
   * } catch (err) {
   *   await client.reportResult(actionId, { status: 'execute_failed', detail: String(err) });
   *   throw err;
   * }
   */
  async approvalGate(opts: ApprovalGateOpts): Promise<ApprovedAction> {
    const {
      kind,
      title,
      preview,
      editable,
      timeoutS,
      // Remaining keys forwarded to createAction (payload, target_url, etc.)
      ...rest
    } = opts;

    const created = await this.createAction({
      kind,
      title,
      preview,
      ...(editable && { editable }),
      ...(rest as Partial<CreateActionParams>),
    });

    return this.awaitDecision(created.id, { timeoutS });
  }

  /**
   * Higher-order wrapper that gates an async function behind Impri approval.
   *
   * Every call to the returned function will:
   *   1. Submit the proposed call to Impri as a pending action.
   *   2. Block until a human approves or rejects.
   *   3. On approval: call the original function (using decision.finalPreview
   *      when editable fields may have been modified by the reviewer).
   *   4. Report the execution outcome to Impri.
   *   5. On rejection: throw ImpriRejected without calling the function.
   *
   * @example
   * const safeSend = client.requiresApproval(
   *   async (to: string, body: string) => sendEmail({ to, body }),
   *   {
   *     kind: 'email.send',
   *     title: (to, _body) => `Send email to ${to}`,
   *     preview: (_to, body) => ({ format: 'plain' as const, body }),
   *     editable: ['preview.body'],
   *   }
   * );
   * await safeSend('alice@example.com', 'Hello!');
   */
  requiresApproval<Args extends unknown[], R>(
    fn: (...args: Args) => Promise<R>,
    opts: RequiresApprovalOpts<Args>,
  ): (...args: Args) => Promise<R> {
    const { kind, title, preview, editable, timeoutS, ...rest } = opts;

    return async (...args: Args): Promise<R> => {
      const resolvedTitle = resolve(title, args);
      const resolvedPreview = preview
        ? resolve(preview, args)
        : ({ format: "plain", body: resolvedTitle } as Preview);

      const created = await this.createAction({
        kind,
        title: resolvedTitle,
        preview: resolvedPreview,
        ...(editable && { editable }),
        ...(rest as Partial<CreateActionParams>),
      });

      // Raises ImpriRejected / ImpriExpired / ImpriTimeout on non-approval.
      const approved = await this.awaitDecision(created.id, { timeoutS });

      // When editable fields were set, the reviewer may have changed preview.body.
      // Inject the edited value back into the function's arguments when the
      // function accepts a single object argument with a 'body' key.
      const effectiveArgs = injectEditedBody(args, approved.finalPreview, resolvedPreview);

      let result: R;
      try {
        result = await fn(...(effectiveArgs as Args));
        await this.reportResult(created.id, { status: "executed" });
      } catch (err) {
        await this.reportResult(created.id, {
          status: "execute_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      return result;
    };
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function buildQs(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(
    (e): e is [string, string] => e[1] !== undefined,
  );
  if (entries.length === 0) return "";
  return "?" + entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * When the reviewer edited preview.body and:
 *   - args is a single object with a 'body' key, replace it with the edited value.
 *   - args has two+ positional arguments matching (to, body) style (string, string),
 *     replace the second positional string with the edited value.
 * In all other cases returns args unchanged.
 */
function injectEditedBody<Args extends unknown[]>(
  args: Args,
  finalPreview: Preview,
  originalPreview: Preview,
): unknown[] {
  // No edit was made; nothing to inject.
  if (finalPreview.body === originalPreview.body) return args;

  // Single-object argument pattern: fn({ ..., body: string })
  if (
    args.length === 1 &&
    typeof args[0] === "object" &&
    args[0] !== null &&
    "body" in (args[0] as object)
  ) {
    return [{ ...(args[0] as Record<string, unknown>), body: finalPreview.body }];
  }

  // Two-positional pattern where the second arg is a string body.
  if (args.length >= 2 && typeof args[1] === "string") {
    return [args[0], finalPreview.body, ...args.slice(2)];
  }

  return args;
}

/**
 * Convenience re-export so callers can import ActionStatus from the main
 * client module without importing types separately.
 */
export type { ActionStatus };
