# Inbox UX & Bulk API

Reference for the web inbox interface, keyboard shortcuts, search/filter parameters,
and the `POST /v1/actions/bulk-decision` REST endpoint.

---

## Contents

- [Filter toolbar](#filter-toolbar)
- [Keyboard navigation](#keyboard-navigation)
- [Bulk selection and bulk actions](#bulk-selection-and-bulk-actions)
- [Inline editable fields and detail panel](#inline-editable-fields-and-detail-panel)
- [Pagination — Load more](#pagination--load-more)
- [Bulk decision API](#bulk-decision-api)
- [Search and filter query parameters](#search-and-filter-query-parameters)
- [SDK — bulkDecide / bulk_decide](#sdk--bulkdecide--bulk_decide)
- [New UI components](#new-ui-components)
- [Security notes](#security-notes)

---

## Filter toolbar

The toolbar lives above the action list and exposes four parameters that are
sent together on every poll cycle.

| Control | Bound parameter | Notes |
|---|---|---|
| Status tabs | `status` | Already wired; pending/approved/rejected/expired/executed/failed |
| Search field | `q` | Free-text; debounced 300 ms; press `/` to focus |
| Kind dropdown | `kind` | Clearable v-select; populated from seen kinds |
| Time range | `since` | All time / Last 24 h / Last 7 d / Last 30 d |

**Active-filter indicator** — when any of `q`, `kind`, or `since` are non-default
a dismissible "Filtered" chip appears with a clear-all button.

**Empty state for active filters** — when the list is empty and any filter is
active, the message reads "No actions match your filters" with a "Clear filters"
button. The "Nothing to review" message only appears when every filter is at its
default.

**Inline loading** — while a background poll is in flight and there are already
items in the list, a 2 px indeterminate progress bar appears at the top of the
list (not a skeleton). Skeleton loaders are shown only on the very first load
(`actions.length === 0`).

---

## Keyboard navigation

All shortcuts are disabled when focus is on an `INPUT`, `TEXTAREA`, `SELECT`, or
a `contenteditable` element.

| Key | Action |
|---|---|
| `j` | Move focus to the next card (wraps at end) |
| `k` | Move focus to the previous card (wraps at start) |
| `Enter` or `Space` | Open ActionDetail for the focused card |
| `a` | Approve the focused card — skips to confirm step when no editable fields; otherwise opens ActionDetail in edit mode |
| `r` | Reject the focused card — opens DecisionDialog pre-set to reject |
| `e` | Open ActionDetail and scroll to the editable fields section |
| `x` | Toggle bulk-selection of the focused card; enters bulk mode if not already active |
| `/` | Focus the search input and select its content (prevents browser find-in-page) |
| `Shift+A` | Bulk-approve all selected cards via `POST /v1/actions/bulk-decision` |
| `Shift+R` | Bulk-reject all selected cards via `POST /v1/actions/bulk-decision` |
| `Escape` | Close open dialog → blur search → deselect all / exit bulk mode (in that order) |
| `?` | Open the keyboard shortcut help overlay |

**Focused card indicator** — the focused card receives a 3 px left border in the
primary color and a visible ARIA focus ring. `j`/`k` auto-scroll the card into
view with `scrollIntoView({ block: 'nearest' })`.

Keyboard state is managed by the `useKeyboardNav` composable
(`ui/src/composables/useKeyboardNav.ts`). It exports:
- `focusedIdx` — current focused list index (ref)
- `selectedIds` — Set of selected action IDs (ref)
- `isBulkMode` — computed `selectedIds.size > 0`
- `focusNext()`, `focusPrev()`, `toggleSelect(id)`, `selectAll(ids)`, `deselectAll()`

---

## Bulk selection and bulk actions

Entering bulk mode: click a checkbox on any ActionCard, or press `x` on the
keyboard-focused card. A sticky bar fixed to the bottom of the viewport appears
showing the count of selected items and **Approve N** / **Reject N** buttons.

**Select all visible** — a checkbox in the filter toolbar becomes visible when
bulk mode is active. Checking it calls `selectAll(actions.map(a => a.id))`;
unchecking it calls `deselectAll()`.

**Excluded from bulk** — actions whose `editable.length > 0` are excluded from
bulk selection (or trigger a warning chip when selected). Per-item edits cannot
be applied in bulk; use `POST /v1/actions/:id/decision` for those.

**Escape** — pressing Escape or deselecting all items collapses the bulk bar.

**Mobile layout** — on viewports ≤ 600 px the bulk bar uses
`position: fixed; bottom: 0; left: 0; right: 0` with full-width stacked buttons.
On desktop it is `position: sticky` at the bottom of the list.

**Optimistic updates** — when a bulk decision is submitted, each selected card is
immediately moved out of the visible list (via `inbox.updateAction()`) before the
API response arrives. If the API returns per-item errors, the affected cards are
restored and a per-item error list is surfaced in a snackbar.

---

## Inline editable fields and detail panel

Editable fields are rendered inside **ActionDetail** rather than in DecisionDialog's
choose step.

- Each field shows its current value as read-only text with an "Edit" icon button
  that toggles a `v-textarea` for that field.
- While editing, a diff block appears below the field using
  `MarkdownPreview format='diff'`, showing `- original` / `+ edited`.
- Clicking **Approve with edits** in the footer passes the edited values to
  DecisionDialog's confirm step, skipping the choose step.

**Copy target URL** — an `mdi-content-copy` icon button sits next to the target
URL link. Clicking it calls `navigator.clipboard.writeText` and shows a brief
"Copied!" snackbar.

**Copy action ID** — the action ID is displayed as a small monospace chip in the
ActionDetail footer with its own copy button. Useful for referencing in agent
logs or support.

**`e` shortcut** — when ActionDetail is opened with the `e` keyboard shortcut, the
editable fields section is scrolled into view on mount (`:openInEditMode` prop).

---

## Pagination — Load more

The inbox uses cursor-based pagination. The server returns `has_more` and
`next_cursor` in every list response.

- When `has_more === true`, a **Load more** button appears at the bottom of the list.
- Clicking it calls `inbox.loadMore()`, which fetches the next page with `cursor`
  and **appends** items to `actions[]` rather than replacing them.
- The polling interval resets on load-more to avoid a race between the next poll
  and the appended page.

---

## Bulk decision API

### `POST /v1/actions/bulk-decision`

Decide up to 50 pending actions in a single request.

**Auth scope:** `actions` (same as single-decision). Admin scope implies it.

**Rate limit:** 10 requests / min per key (route key `actions:bulk-decide`).
Each request can touch up to 50 rows, so effective throughput is 500 decisions/min —
8× the single-item ceiling of 60/min.

#### Request body

```json
{
  "ids":     ["act_aaa", "act_bbb"],
  "verdict": "approve",
  "comment": "Looks good — shipping."
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `ids` | `string[]` | yes | 1–50 action IDs; server deduplicates |
| `verdict` | `"approve"` \| `"reject"` | yes | Applied to all items in the batch |
| `comment` | `string` | no | Max 500 chars; stored in `decisions.comment` |

No `edited` field — bulk intentionally omits per-item edits. Actions with
`editable.length > 0` must be decided via `POST /v1/actions/:id/decision`.

Validation errors return **400** with the standard Zod issues shape before any
rate-limit or DB access.

#### Response — 200

HTTP 200 even on partial failure. The batch was processed; per-item results carry
the outcome.

```json
{
  "results": [
    { "id": "act_aaa", "ok": true,  "status": "approved" },
    { "id": "act_bbb", "ok": false, "error": "already_decided", "current_status": "approved" },
    { "id": "act_ccc", "ok": false, "error": "not_found" },
    { "id": "act_ddd", "ok": false, "error": "internal" }
  ],
  "succeeded": 1,
  "failed":    3
}
```

| `error` value | Meaning |
|---|---|
| `"not_found"` | ID does not exist in the caller's project (also used for out-of-project IDs — no information disclosure) |
| `"already_decided"` | `action.status !== "pending"`; `current_status` is provided |
| `"internal"` | Unexpected DB error; logged server-side, not surfaced to caller |

#### Atomicity model

Each item is decided in its own transaction (the same `commitDecision` transaction
that single-decision uses). A failure on item N does **not** roll back successes
on items 0..N-1. This per-item-atomic, batch-partial model avoids lock escalation
on SQLite and matches UX expectations: bulk-approve 20 items, 3 already-decided →
17 succeed, 3 fail gracefully.

#### Audit trail

Each succeeded item writes one `audit_log` row and one `pii_log` row, identical
to single-decision. Channel is set to `"bulk-web"` (browser UI) or `"bulk-api"`
(programmatic), preserving the ability to distinguish bulk operations in audit
queries.

#### Required DB migration

```sql
ALTER TABLE decisions ADD COLUMN comment TEXT;
-- nullable; existing rows unaffected
```

#### Zod schema (server/src/schemas.ts)

```typescript
export const BulkDecisionBody = z.object({
  ids:     z.array(z.string().min(1)).min(1).max(50),
  verdict: z.enum(['approve', 'reject']),
  comment: z.string().max(500).optional(),
});
```

---

## Search and filter query parameters

### `GET /v1/actions` — full parameter table

| Parameter | Type | Server support | UI support | Notes |
|---|---|---|---|---|
| `status` | `ActionStatus` | yes | yes | `pending` \| `approved` \| `rejected` \| `expired` \| `executed` \| `execute_failed` |
| `q` | `string` | **NEW** | **NEW** | Free-text LIKE search on `title` and `preview.body`; max 200 chars |
| `kind` | `string` | yes | **NEW** | Exact match; single value only in v1 |
| `since` | `integer` | yes | **NEW** | Unix timestamp; actions created at or after this time |
| `limit` | `1–100` | yes | yes | Default 50; UI uses 50 for initial page, cursor for subsequent pages |
| `cursor` | `string` | yes | **NEW** | Composite (created_at + id) cursor from `next_cursor` in previous response |

#### New server parameter: `q`

Add to `ListActionsQuery` in `server/src/schemas.ts`:

```typescript
q: z.string().max(200).optional(),
```

SQL implementation in `server/src/routes/actions.ts` (after existing kind/since filters):

```typescript
if (q.q) {
  // Escape LIKE metacharacters to prevent wildcard injection
  const pattern = '%' + q.q.replace(/[%_\\]/g, c => '\\' + c) + '%';
  sql += " AND (title LIKE ? ESCAPE '\\' OR json_extract(preview, '$.body') LIKE ? ESCAPE '\\')";
  params.push(pattern, pattern);
}
```

This uses `json_extract` to search only the preview body string, not the format
key name. SQLite JSON1 is available in `better-sqlite3` by default. For very large
tables, add a covering index:

```sql
CREATE INDEX IF NOT EXISTS idx_actions_project_status_created
  ON actions(project_id, status, created_at DESC);
```

Full-text search with FTS5 can be added later if LIKE performance degrades.

---

## SDK — bulkDecide / bulk_decide

### TypeScript (ui/src/api/client.ts)

New types (`ui/src/types.ts`):

```typescript
export interface BulkDecisionRequest {
  ids:     string[]
  verdict: 'approve' | 'reject'
  comment?: string
}

export interface BulkDecisionResult {
  id:             string
  ok:             boolean
  status?:        ActionStatus
  error?:         string
  current_status?: ActionStatus
}

export interface BulkDecisionResponse {
  results:   BulkDecisionResult[]
  succeeded: number
  failed:    number
}
```

New method on `ApiClient`:

```typescript
async bulkDecide(req: BulkDecisionRequest): Promise<BulkDecisionResponse> {
  return this.request<BulkDecisionResponse>('POST', '/actions/bulk-decision', req)
}
```

### Python SDK (sdk/python/)

```python
await client.bulk_decide(
    ids=["act_aaa", "act_bbb"],
    verdict="approve",
    comment="Looks good.",
)
# Returns BulkDecisionResponse with .results, .succeeded, .failed
```

Method signature:

```python
async def bulk_decide(
    self,
    ids: list[str],
    verdict: Literal["approve", "reject"],
    comment: str | None = None,
) -> BulkDecisionResponse:
    ...
```

Raises `ImpriValidationError` on 400, `ImpriRateLimited` on 429. Individual item
failures are surfaced in `BulkDecisionResponse.results`, not as exceptions.

---

## New UI components

| Component | Location | Purpose |
|---|---|---|
| `BulkActionBar.vue` | `ui/src/components/` | Sticky/fixed bottom bar; shows count + Approve N / Reject N |
| `InboxSearchBar.vue` | `ui/src/components/` | Filter toolbar: q field, kind select, since select, clear-all chip |
| `ShortcutHelpDialog.vue` | `ui/src/components/` | Two-column shortcut table; opened by `?` |
| `useKeyboardNav.ts` | `ui/src/composables/` | Composable: focusedIdx, selectedIds, bulk-mode logic |

**Modified components:**

- `InboxList.vue` — integrates `InboxSearchBar`, `BulkActionBar`, `useKeyboardNav`;
  wires q/kind/since into `inbox.fetchActions()`; adds "Load more" button; adds
  "Select all visible" checkbox in bulk mode.
- `ActionCard.vue` — adds `:focused`, `:selected`, `:bulkMode`, `:highlight` props;
  renders checkbox in left gutter; applies focus-ring and primary left border when
  focused; wraps matching substrings in `<mark>` (plain text, no v-html).
- `ActionDetail.vue` — moves editable fields from DecisionDialog into the panel;
  adds diff preview; adds copy buttons for `target_url` and action ID; accepts
  `:openInEditMode` prop.
- `DecisionDialog.vue` — adds `:initialEdited` prop; when provided, skips the
  choose step and merges edits into the confirm payload.
- `inbox.ts` store — adds `selectedIds`, `searchQuery`, `kindFilter`, `sinceFilter`,
  `bulkDecide()`, `loadMore()`.

---

## Security notes

1. **Project isolation** — every ID lookup in `POST /v1/actions/bulk-decision` uses
   `WHERE id = ? AND project_id = ?` binding `project_id` from the verified key
   record (never from the request body). Out-of-project IDs return
   `ok: false, error: "not_found"` — indistinguishable from a missing ID.

2. **Scope check first** — `hasScope(key.scopes, 'actions')` is evaluated before
   rate-limit or any DB access, consistent with all other action endpoints.

3. **Batch size cap** — `z.array(...).max(50)` is enforced by Zod before any DB
   work. IDs are deduplicated server-side (`new Set(ids)`) before processing.

4. **No editable bypass** — `BulkDecisionBody` has no `edited` field. The editable
   whitelist check (PLAYBOOK A3) applies only to single-decision; bulk operations
   are intentionally edit-free.

5. **Comment injection** — `comment` is stored via parameterized `.run(..., body.comment ?? null)`.
   In the UI it is rendered as text content (`{{ }}`), never `v-html`.

6. **UNIQUE constraint race** — the `UNIQUE` constraint on `decisions(action_id)`
   makes concurrent bulk requests safe: the losing `INSERT` returns
   `ok: false, error: "already_decided"`.

7. **Audit completeness** — 50-item bulk = 50 `audit_log` rows + 50 `pii_log`
   rows. Channel `"bulk-web"` / `"bulk-api"` distinguishes bulk from single
   operations in audit queries.
