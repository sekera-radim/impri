import type {
  Action,
  ActionCreated,
  ActionStatus,
  ApiKey,
  ApiKeyCreated,
  ApprovedAction,
  CreateActionParams,
  CreateWatcherFromPresetParams,
  CreateWatcherParams,
  Decision,
  DecisionResult,
  KeyScope,
  ListActionsParams,
  ListWatchersParams,
  PagedResult,
  Preview,
  Project,
  ProjectExport,
  ResultAck,
  UpdateProjectParams,
  UpdateWatcherParams,
  Watcher,
  WatcherPreset,
  WatcherSchedule,
  WatcherWithItemCount,
} from './types.js'

import {
  ImpriApiError,
  ImpriConfigError,
  ImpriConflict,
  ImpriExpired,
  ImpriNotFound,
  ImpriQuotaExceeded,
  ImpriRateLimited,
  ImpriRejected,
  ImpriTimeout,
  ImpriUnauthorized,
  ImpriValidationError,
} from './errors.js'

// ─── Client options ────────────────────────────────────────────────────────────

export interface ImpriClientOptions {
  /**
   * Bearer token — any key starting with `im_`.
   * Falls back to the IMPRI_API_KEY environment variable.
   * Raises ImpriConfigError at construction time when neither is set.
   */
  apiKey?: string
  /**
   * API base URL without /v1. Falls back to the IMPRI_BASE_URL environment
   * variable, then `http://localhost:8484` (self-hosted default).
   * Cloud: `https://api.impri.dev`
   * Trailing slashes are stripped automatically.
   */
  baseUrl?: string
}

const DEFAULT_BASE_URL = 'http://localhost:8484'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveEnv(name: string): string | undefined {
  // Guard for non-Node environments (browsers, edge runtimes).
  if (typeof process !== 'undefined' && process.env) {
    return process.env[name]
  }
  return undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Stable djb2-XOR hash — pure JS, no deps.
 * Used to auto-generate idempotency keys from (kind, title, preview.body).
 */
function djb2(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = (((hash << 5) + hash) ^ str.charCodeAt(i)) >>> 0
  }
  return hash
}

/**
 * Generate a stable idempotency key for a given (kind, title, previewBody)
 * triple, scoped to the current process and UTC calendar day. This means
 * retried calls within the same logical task on the same day de-duplicate
 * automatically; callers may always override by supplying their own key.
 */
function autoIdempotencyKey(kind: string, title: string, previewBody: string): string {
  const dayBucket = Math.floor(Date.now() / 86_400_000)
  const pid =
    typeof process !== 'undefined' && typeof process.pid === 'number' ? process.pid : 0
  const hash = djb2(`${kind}\x00${title}\x00${previewBody}`).toString(16)
  return `sdk-${pid}-${dayBucket}-${hash}`
}

function normalizeAction(raw: unknown): Action {
  const r = raw as Record<string, unknown>
  const payload = r.payload as Record<string, unknown> | null | undefined
  return {
    ...(r as unknown as Action),
    editable: (r.editable as string[] | undefined) ?? [],
    is_untrusted: payload?.untrusted === true,
  }
}

function buildQuery(
  params: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  const q: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) {
      q[k] = v
    }
  }
  return q
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class ImpriClient {
  private readonly _apiKey: string
  private readonly _baseUrl: string

  constructor(options: ImpriClientOptions = {}) {
    const apiKey = options.apiKey ?? resolveEnv('IMPRI_API_KEY')
    if (!apiKey) {
      throw new ImpriConfigError(
        'No API key provided. Pass apiKey to the constructor or set IMPRI_API_KEY.',
      )
    }

    const rawBaseUrl =
      options.baseUrl ?? resolveEnv('IMPRI_BASE_URL') ?? DEFAULT_BASE_URL

    // Strip trailing slash(es) so /v1/... appends cleanly.
    const trimmed = rawBaseUrl.replace(/\/+$/, '')
    try {
      new URL(trimmed)
    } catch {
      throw new ImpriConfigError(`Invalid baseUrl: "${rawBaseUrl}"`)
    }

    this._apiKey = apiKey
    this._baseUrl = trimmed
  }

  // ─── HTTP core ─────────────────────────────────────────────────────────────

  private async _request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean>,
  ): Promise<T> {
    let url = `${this._baseUrl}/v1${path}`

    if (query && Object.keys(query).length > 0) {
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(query)) {
        params.set(k, String(v))
      }
      url += `?${params.toString()}`
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this._apiKey}`,
      Accept: 'application/json',
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    if (!res.ok) {
      return this._throwApiError(res)
    }

    if (res.status === 204) {
      return undefined as unknown as T
    }

    return res.json() as Promise<T>
  }

  private async _throwApiError(res: Response): Promise<never> {
    let body: Record<string, unknown> = {}
    try {
      body = (await res.json()) as Record<string, unknown>
    } catch {
      // JSON parse failure — fall through with empty body
    }

    const message = ((body.message ?? body.error ?? '') as string) || res.statusText

    switch (res.status) {
      case 401:
      case 403:
        throw new ImpriUnauthorized(
          `Authentication failed (HTTP ${res.status}): ${message}`,
          res.status,
          body,
        )
      case 402:
        throw new ImpriQuotaExceeded(
          `Quota exceeded: ${message}`,
          body,
          body.limit as number | undefined,
          body.tier as string | undefined,
        )
      case 404:
        throw new ImpriNotFound(
          `Not found (HTTP 404): ${message}`,
          body,
        )
      case 409:
        throw new ImpriConflict(
          `Conflict (HTTP 409): ${message}`,
          body,
        )
      case 410:
        throw new ImpriExpired(
          `Approval window closed (HTTP 410): ${message}`,
          body,
        )
      case 429: {
        const retryAfterHeader = res.headers.get('Retry-After')
        const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined
        throw new ImpriRateLimited(
          `Rate limit exceeded (HTTP 429): ${message}`,
          body,
          Number.isNaN(retryAfter) ? undefined : retryAfter,
        )
      }
      case 400:
      case 422:
        throw new ImpriValidationError(
          `Validation error (HTTP ${res.status}): ${message}`,
          res.status,
          body,
          (body.issues as unknown[]) ?? [],
        )
      default:
        throw new ImpriApiError(
          `Impri API error (HTTP ${res.status}): ${message}`,
          res.status,
          body,
        )
    }
  }

  // ─── Pagination helper ─────────────────────────────────────────────────────

  private async _autoPaginate<T>(
    path: string,
    query: Record<string, string | number | boolean>,
    transform: (raw: unknown) => T,
  ): Promise<PagedResult<T>> {
    const collected: T[] = []
    let cursor: string | undefined

    while (true) {
      const q = cursor ? { ...query, cursor } : { ...query }
      const page = await this._request<{
        items: unknown[]
        has_more: boolean
        next_cursor?: string
      }>('GET', path, undefined, q)

      for (const item of page.items) {
        collected.push(transform(item))
      }

      if (!page.has_more || !page.next_cursor) {
        return { items: collected, has_more: false, next_cursor: undefined }
      }

      cursor = page.next_cursor
    }
  }

  // ─── Actions ───────────────────────────────────────────────────────────────

  /**
   * POST /v1/actions
   *
   * Submit an action for human approval. Returns 201 for a new action and 200
   * when an idempotency_key match or soft-dup (same kind+title+preview hash,
   * already pending) is found — check `.duplicate_of` to distinguish.
   *
   * An idempotency_key is auto-generated from (kind, title, preview.body)
   * when omitted, scoped to the current process and UTC calendar day.
   *
   * Requires 'actions' scope.
   */
  async createAction(params: CreateActionParams): Promise<ActionCreated> {
    const body = {
      ...params,
      idempotency_key:
        params.idempotency_key ??
        autoIdempotencyKey(params.kind, params.title, params.preview.body),
    }
    return this._request<ActionCreated>('POST', '/actions', body)
  }

  /**
   * GET /v1/actions/:id
   *
   * Fetch a single action with its current status and decision (once decided).
   * Use `action.decision.final_preview` for execution when editable fields
   * may have been modified by the reviewer.
   *
   * Requires 'actions' scope.
   */
  async getAction(actionId: string): Promise<Action> {
    const raw = await this._request<unknown>('GET', `/actions/${actionId}`)
    return normalizeAction(raw)
  }

  /**
   * GET /v1/actions
   *
   * Cursor-paginated list of actions for the project, newest first.
   * Pass `autoPaginate: true` to collect all pages automatically.
   *
   * Requires 'actions' scope.
   */
  async listActions(params: ListActionsParams = {}): Promise<PagedResult<Action>> {
    const { autoPaginate, ...rest } = params
    const q = buildQuery({
      status: rest.status,
      kind: rest.kind,
      since: rest.since,
      limit: rest.limit,
      cursor: rest.cursor,
    })

    if (autoPaginate) {
      return this._autoPaginate<Action>('/actions', q, normalizeAction)
    }

    const page = await this._request<{
      items: unknown[]
      has_more: boolean
      next_cursor?: string
    }>('GET', '/actions', undefined, q)

    return {
      items: page.items.map(normalizeAction),
      has_more: page.has_more,
      next_cursor: page.next_cursor,
    }
  }

  /**
   * POST /v1/actions/:id/decision
   *
   * Approve or reject an action. Used primarily by the web inbox; the SDK
   * exposes it for programmatic approvals or rejection scripts.
   *
   * `edited` is a dict of dot-path overrides (e.g. `{ 'preview.body': '...' }`)
   * restricted to the action's `editable` whitelist.
   *
   * Requires 'actions' scope. Throws ImpriConflict if already decided.
   */
  async decide(
    actionId: string,
    verdict: 'approve' | 'reject',
    opts: { edited?: Record<string, unknown>; channel?: string } = {},
  ): Promise<DecisionResult> {
    const body: Record<string, unknown> = { verdict }
    if (opts.edited !== undefined) body.edited = opts.edited
    if (opts.channel !== undefined) body.channel = opts.channel
    return this._request<DecisionResult>('POST', `/actions/${actionId}/decision`, body)
  }

  /**
   * POST /v1/actions/:id/result
   *
   * Report execution outcome after executing an approved action. Transitions
   * state to 'executed' or 'execute_failed'. Always call this — it closes the
   * audit loop in the inbox.
   *
   * Requires 'actions' scope. Throws ImpriConflict if action is not 'approved'.
   */
  async reportResult(
    actionId: string,
    status: 'executed' | 'execute_failed',
    opts: { detail?: string } = {},
  ): Promise<ResultAck> {
    const body: Record<string, unknown> = { status }
    if (opts.detail !== undefined) body.detail = opts.detail
    return this._request<ResultAck>('POST', `/actions/${actionId}/result`, body)
  }

  /**
   * Poll GET /v1/actions/:id until status leaves 'pending' or timeout elapses.
   *
   * - Approved  → returns the full Action. Use `.decision.final_preview` for
   *   execution when `editable` fields may have been modified by the reviewer.
   * - Rejected  → throws ImpriRejected (handle as a normal outcome, not an error).
   * - Expired   → throws ImpriExpired.
   * - Timeout   → throws ImpriTimeout (action stays pending server-side — call
   *   awaitDecision again to resume).
   *
   * Default poll floor is 5 s; rate limit is 300 GET/min. Do not set
   * pollIntervalS below 5 in production.
   */
  async awaitDecision(
    actionId: string,
    opts: { timeoutS?: number; pollIntervalS?: number } = {},
  ): Promise<Action> {
    const timeoutS = opts.timeoutS ?? 300
    const pollIntervalMs = (opts.pollIntervalS ?? 5) * 1000
    const deadline = Date.now() + timeoutS * 1000

    while (true) {
      const action = await this.getAction(actionId)

      switch (action.status) {
        case 'approved':
        case 'executed':
        case 'execute_failed':
          return action

        case 'rejected':
          throw new ImpriRejected(
            actionId,
            action.decision as Decision,
            action.decision?.final_preview,
          )

        case 'expired':
          throw new ImpriExpired(
            `Action ${actionId} has expired — the approval window closed. ` +
              'Create a new action if the task is still relevant.',
            action,
          )

        // 'pending' — keep polling
      }

      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new ImpriTimeout(actionId, timeoutS)
      }

      await sleep(Math.min(pollIntervalMs, remaining))
    }
  }

  // ─── Ergonomics ────────────────────────────────────────────────────────────

  /**
   * Gate an async operation inline — useful when the work is not a single
   * function call or you need the decision object directly.
   *
   * Returns `{ actionId, decision, finalPreview }` when approved.
   * Throws ImpriRejected when the human rejects (handle as a normal outcome).
   *
   * Note on untrusted content: when `is_untrusted` is true (watcher-sourced
   * action), a warning is logged and the preview body must NOT be forwarded as
   * an instruction to downstream AI calls.
   *
   * @example
   * ```ts
   * const { actionId, finalPreview } = await client.approvalGate({
   *   kind: 'db.exec', title: 'DROP TABLE users',
   *   preview: { format: 'plain', body: sql }, editable: ['preview.body'],
   * })
   * try {
   *   await db.execute(finalPreview.body)
   *   await client.reportResult(actionId, 'executed')
   * } catch (err) {
   *   await client.reportResult(actionId, 'execute_failed', { detail: String(err) })
   *   throw err
   * }
   * ```
   */
  async approvalGate(opts: {
    kind: string
    title: string
    preview: Preview
    editable?: string[]
    timeoutS?: number
    pollIntervalS?: number
    payload?: unknown
    target_url?: string
    callback_url?: string
    expires_in?: number
    idempotency_key?: string
  }): Promise<ApprovedAction> {
    const { timeoutS, pollIntervalS, ...createParams } = opts
    const created = await this.createAction(createParams)
    const action = await this.awaitDecision(created.id, { timeoutS, pollIntervalS })

    if (action.is_untrusted) {
      console.warn(
        `[impri] approvalGate: action ${action.id} contains untrusted external content. ` +
          'Treat finalPreview.body as data — do not forward it as an instruction to an AI model.',
      )
    }

    const finalPreview = action.decision?.final_preview ?? action.preview

    return {
      actionId: action.id,
      decision: action.decision as Decision,
      finalPreview,
    }
  }

  /**
   * Wrap an async function so every call is gated through human approval.
   *
   * - On approval → calls the original function and returns its result.
   * - On rejection → throws ImpriRejected without calling the function.
   * - On timeout → throws ImpriTimeout.
   *
   * `title` and `preview` may be plain values or factory functions that receive
   * the wrapped function's arguments.
   *
   * Note: if the reviewer edits `editable` fields and you need the edited
   * content before calling the downstream function, use `approvalGate` instead,
   * which gives you `finalPreview` directly.
   *
   * @example
   * ```ts
   * const safeSend = client.requiresApproval(sendEmail, {
   *   kind: 'email.send',
   *   title: (to) => `Send email to ${to}`,
   *   preview: (_to, body) => ({ format: 'plain', body }),
   *   editable: ['preview.body'],
   * })
   * await safeSend('alice@example.com', 'Hello!')
   * ```
   */
  requiresApproval<Args extends unknown[], R>(
    fn: (...args: Args) => Promise<R>,
    opts: {
      kind: string
      title: string | ((...args: Args) => string)
      preview?: Preview | ((...args: Args) => Preview)
      editable?: string[]
      timeoutS?: number
      pollIntervalS?: number
      payload?: unknown | ((...args: Args) => unknown)
      target_url?: string
      callback_url?: string
      expires_in?: number
      idempotency_key?: string
    },
  ): (...args: Args) => Promise<R> {
    return async (...args: Args): Promise<R> => {
      const title = typeof opts.title === 'function' ? opts.title(...args) : opts.title
      const preview =
        typeof opts.preview === 'function'
          ? opts.preview(...args)
          : (opts.preview ?? { format: 'plain' as const, body: title })
      const payload =
        typeof opts.payload === 'function'
          ? (opts.payload as (...a: Args) => unknown)(...args)
          : opts.payload

      // Gate: throws ImpriRejected, ImpriExpired, or ImpriTimeout on non-approval.
      await this.approvalGate({
        kind: opts.kind,
        title,
        preview,
        editable: opts.editable,
        timeoutS: opts.timeoutS,
        pollIntervalS: opts.pollIntervalS,
        payload,
        target_url: opts.target_url,
        callback_url: opts.callback_url,
        expires_in: opts.expires_in,
        idempotency_key: opts.idempotency_key,
      })

      // Approved — call the original function with the original arguments.
      // For edit-aware flows (editable fields changed by reviewer), use
      // approvalGate directly to access finalPreview before calling fn.
      return fn(...args)
    }
  }

  // ─── Watchers ──────────────────────────────────────────────────────────────

  /**
   * POST /v1/watchers
   *
   * Create a monitoring watcher. Items matching at least min_score points from
   * keyword rules (and none of keywords_none patterns) are delivered to the
   * inbox as pending actions with `payload.untrusted = true`.
   *
   * Requires 'watch' scope.
   */
  async createWatcher(params: CreateWatcherParams): Promise<Watcher> {
    return this._request<Watcher>('POST', '/watchers', params)
  }

  /**
   * GET /v1/watchers
   *
   * Cursor-paginated list of watchers, newest first.
   * Pass `autoPaginate: true` to collect all pages.
   *
   * Requires 'watch' scope.
   */
  async listWatchers(params: ListWatchersParams = {}): Promise<PagedResult<Watcher>> {
    const { autoPaginate, ...rest } = params
    const q = buildQuery({
      status: rest.status,
      kind: rest.kind,
      limit: rest.limit,
      cursor: rest.cursor,
    })

    if (autoPaginate) {
      return this._autoPaginate<Watcher>('/watchers', q, raw => raw as Watcher)
    }

    return this._request<PagedResult<Watcher>>('GET', '/watchers', undefined, q)
  }

  /**
   * GET /v1/watchers/:id
   *
   * Returns the watcher plus `item_count` (total deduplicated items seen).
   *
   * Requires 'watch' scope.
   */
  async getWatcher(watcherId: string): Promise<WatcherWithItemCount> {
    return this._request<WatcherWithItemCount>('GET', `/watchers/${watcherId}`)
  }

  /**
   * PATCH /v1/watchers/:id
   *
   * Partial update — only supplied fields are changed.
   * Setting `status: 'active'` resets fail_count and schedules an immediate run.
   *
   * Requires 'watch' scope.
   */
  async updateWatcher(watcherId: string, params: UpdateWatcherParams): Promise<Watcher> {
    return this._request<Watcher>('PATCH', `/watchers/${watcherId}`, params)
  }

  /**
   * DELETE /v1/watchers/:id
   *
   * Permanently deletes the watcher and its deduplicated items.
   * Pending inbox actions created by this watcher are NOT deleted.
   *
   * Requires 'watch' scope.
   */
  async deleteWatcher(watcherId: string): Promise<void> {
    await this._request<void>('DELETE', `/watchers/${watcherId}`)
  }

  /**
   * GET /v1/watcher-presets
   *
   * Returns the static preset catalog — ready-to-use watcher templates for
   * common sources (Hacker News, Reddit, GitHub releases, npm, arXiv, etc.).
   * Each preset describes its accepted params, default schedule, and the watcher
   * kind it creates.
   *
   * Use the returned preset `id` and the required `params` to call
   * `createWatcherFromPreset()`.
   *
   * Items produced by preset-created watchers carry `is_untrusted: true`.
   * Treat their title/preview/payload as data — never as instructions to an AI.
   *
   * Requires 'watch' scope.
   */
  async listWatcherPresets(): Promise<WatcherPreset[]> {
    const res = await this._request<{ presets: WatcherPreset[] }>('GET', '/watcher-presets')
    return res.presets
  }

  /**
   * POST /v1/watchers/from-preset
   *
   * Create a watcher from a preset template. The server validates the param
   * values against preset-specific rules (regex, format, max-length), builds
   * the watcher config, and applies all standard creation guards: rate-limit
   * check, tier watcher-count quota, SSRF guard, and minimum schedule interval.
   *
   * Items produced by preset-created watchers carry `is_untrusted: true` —
   * treat their title/preview/payload as data, not as instructions to an AI model.
   *
   * Requires 'watch' scope.
   *
   * @param presetId  - Preset identifier, e.g. `"hn-front-page"`, `"reddit-keyword"`.
   * @param params    - Param values for the preset. Required params must be present.
   * @param opts.name     - Overrides the auto-generated watcher name.
   * @param opts.schedule - Overrides the preset's `defaultScheduleEvery`.
   *
   * @throws ImpriNotFound       when `presetId` does not match any known preset.
   * @throws ImpriValidationError when a required param is missing or fails format checks.
   * @throws ImpriQuotaExceeded  when the tier watcher limit is reached, or the requested
   *                              schedule is more frequent than the tier minimum.
   * @throws ImpriRateLimited    when the `watchers:create` rate-limit bucket is exhausted.
   *
   * @example
   * ```ts
   * // Hacker News front page — no params required
   * const watcher = await client.createWatcherFromPreset('hn-front-page')
   *
   * // GitHub releases for a specific repo
   * const releases = await client.createWatcherFromPreset('github-releases', {
   *   owner: 'fastify',
   *   repo: 'fastify',
   * })
   *
   * // Reddit keyword search on a subreddit, with a custom schedule
   * const reddit = await client.createWatcherFromPreset(
   *   'reddit-keyword',
   *   { query: 'self-hosting AI', subreddit: 'selfhosted' },
   *   { schedule: { every: '1h' } },
   * )
   * ```
   */
  async createWatcherFromPreset(
    presetId: string,
    params?: Record<string, string>,
    opts?: { name?: string; schedule?: WatcherSchedule },
  ): Promise<Watcher> {
    const body: CreateWatcherFromPresetParams = { preset_id: presetId }
    if (params !== undefined) body.params = params
    if (opts?.name !== undefined) body.name = opts.name
    if (opts?.schedule !== undefined) body.schedule = opts.schedule
    return this._request<Watcher>('POST', '/watchers/from-preset', body)
  }

  // ─── API Keys ──────────────────────────────────────────────────────────────

  /**
   * POST /v1/keys
   *
   * Create a new API key. The raw `im_...` value is returned exactly once —
   * store it immediately. Requires 'admin' scope.
   */
  async createKey(name: string, scopes: KeyScope[]): Promise<ApiKeyCreated> {
    return this._request<ApiKeyCreated>('POST', '/keys', { name, scopes })
  }

  /**
   * GET /v1/keys
   *
   * List all keys for the project including revoked ones (revoked=true).
   * Raw key values are never returned after creation.
   *
   * Requires 'admin' scope.
   */
  async listKeys(): Promise<ApiKey[]> {
    return this._request<ApiKey[]>('GET', '/keys')
  }

  /**
   * DELETE /v1/keys/:id
   *
   * Revoke a key. Subsequent requests with that key will fail 401/403.
   *
   * Requires 'admin' scope.
   */
  async revokeKey(keyId: string): Promise<void> {
    await this._request<void>('DELETE', `/keys/${keyId}`)
  }

  // ─── Project ───────────────────────────────────────────────────────────────

  /**
   * GET /v1/project
   *
   * Returns project metadata including `webhook_secret` (needed to verify
   * X-Impri-Signature). Keep webhook_secret out of logs and VCS.
   *
   * Requires 'admin' scope.
   */
  async getProject(): Promise<Project> {
    return this._request<Project>('GET', '/project')
  }

  /**
   * PATCH /v1/project
   *
   * Update project name and/or IANA timezone. The timezone drives watcher
   * schedule `window` fields (e.g. only run during 06:00–22:00 local time).
   *
   * Requires 'admin' scope.
   */
  async updateProject(params: UpdateProjectParams): Promise<Project> {
    return this._request<Project>('PATCH', '/project', params)
  }

  /**
   * POST /v1/project/rotate-webhook-secret
   *
   * Generate a new random webhook signing secret. The old secret is immediately
   * invalidated — update your webhook handler before rotating in production.
   *
   * Requires 'admin' scope.
   */
  async rotateWebhookSecret(): Promise<{ webhook_secret: string; note: string }> {
    return this._request<{ webhook_secret: string; note: string }>(
      'POST',
      '/project/rotate-webhook-secret',
    )
  }

  /**
   * GET /v1/project/export
   *
   * Full GDPR data export of all project-scoped tables.
   *
   * Requires 'admin' scope.
   */
  async exportProject(): Promise<ProjectExport> {
    return this._request<ProjectExport>('GET', '/project/export')
  }

  /**
   * DELETE /v1/project/data
   *
   * GDPR erasure — irreversible. Wipes all actions, decisions, watchers,
   * watcher_items, audit_log, and pii_log for the project. The project record
   * and API keys are preserved. Returns counts of erased rows.
   *
   * Requires 'admin' scope.
   */
  async eraseProjectData(): Promise<{ erased: true; actions: number; watchers: number }> {
    return this._request<{ erased: true; actions: number; watchers: number }>(
      'DELETE',
      '/project/data',
    )
  }
}
