<template>
  <!-- ─── Header ─────────────────────────────────────────────────────────────── -->
  <div class="d-flex align-center mb-4 gap-2">
    <span class="text-h6">Audit Log</span>
    <v-spacer />
    <v-btn
      icon="mdi-refresh"
      variant="text"
      size="small"
      title="Refresh"
      aria-label="Refresh audit log"
      :loading="store.loading"
      @click="refresh"
    />
    <!-- Export dropdown -->
    <v-menu>
      <template #activator="{ props: menuProps }">
        <v-btn
          v-bind="menuProps"
          variant="outlined"
          size="small"
          prepend-icon="mdi-download-outline"
          append-icon="mdi-chevron-down"
          :loading="store.exporting"
        >
          Export
        </v-btn>
      </template>
      <v-list density="compact">
        <v-list-item
          prepend-icon="mdi-code-json"
          title="Export as NDJSON"
          @click="doExport('json')"
        />
        <v-list-item
          prepend-icon="mdi-file-delimited-outline"
          title="Export as CSV"
          @click="doExport('csv')"
        />
      </v-list>
    </v-menu>
  </div>

  <!-- ─── Filter row ──────────────────────────────────────────────────────────── -->
  <div class="d-flex flex-wrap gap-2 mb-4 align-center">
    <!-- Event type -->
    <v-select
      v-model="typeFilter"
      :items="EVENT_TYPE_OPTIONS"
      item-title="title"
      item-value="value"
      label="Event type"
      variant="outlined"
      density="compact"
      hide-details
      clearable
      class="filter-type"
      @update:model-value="onTypeChange"
    />

    <!-- Actor key ID -->
    <v-text-field
      v-model="actorFilter"
      label="Actor key"
      variant="outlined"
      density="compact"
      hide-details
      clearable
      placeholder="key_…"
      class="filter-id"
      @update:model-value="onTextFilterChange"
    />

    <!-- Entity ID -->
    <v-text-field
      v-model="entityFilter"
      label="Entity ID"
      variant="outlined"
      density="compact"
      hide-details
      clearable
      placeholder="act_… / rul_… / …"
      class="filter-id"
      @update:model-value="onTextFilterChange"
    />

    <!-- Date range -->
    <v-text-field
      v-model="sinceFilter"
      type="date"
      label="From"
      variant="outlined"
      density="compact"
      hide-details
      class="filter-date"
      @update:model-value="onDateChange"
    />
    <v-text-field
      v-model="untilFilter"
      type="date"
      label="To"
      variant="outlined"
      density="compact"
      hide-details
      class="filter-date"
      @update:model-value="onDateChange"
    />

    <!-- Active filter pill -->
    <v-chip
      v-if="hasActiveFilters"
      closable
      color="primary"
      size="small"
      variant="tonal"
      @click:close="clearFilters"
    >
      Filtered
    </v-chip>
  </div>

  <!-- ─── Error alert ──────────────────────────────────────────────────────────── -->
  <v-alert
    v-if="store.error"
    type="error"
    variant="tonal"
    density="compact"
    class="mb-4"
    closable
    @click:close="store.error = null"
  >
    {{ store.error }}
  </v-alert>

  <!-- ─── Loading skeleton ─────────────────────────────────────────────────────── -->
  <template v-if="store.loading && store.events.length === 0">
    <v-skeleton-loader
      v-for="i in 6"
      :key="i"
      type="table-row"
      class="mb-1"
    />
  </template>

  <!-- ─── Empty state ───────────────────────────────────────────────────────────── -->
  <v-card
    v-else-if="!store.loading && store.events.length === 0 && !store.error"
    variant="outlined"
    class="text-center py-10 px-4"
  >
    <v-icon size="44" color="grey-lighten-1" class="mb-3">mdi-history</v-icon>
    <div class="text-body-1 font-weight-medium">
      {{ hasActiveFilters ? 'No events match the current filters' : 'No audit events yet' }}
    </div>
    <div class="text-body-2 text-medium-emphasis mt-1 mb-5 mx-auto" style="max-width: 460px">
      <template v-if="hasActiveFilters">
        Try broadening your filter criteria, or
        <v-btn variant="text" size="x-small" class="text-none" @click="clearFilters">clear all filters</v-btn>
        to see all events.
      </template>
      <template v-else>
        Audit events are recorded as your agents create and decide actions, manage watchers,
        keys, notification channels, and project settings.
        <br>
        <span class="text-caption mt-1 d-block">Requires an admin-scope API key.</span>
      </template>
    </div>
  </v-card>

  <!-- ─── Table ─────────────────────────────────────────────────────────────────── -->
  <template v-else-if="store.events.length > 0">
    <v-card variant="outlined" class="pa-0">
      <div class="table-scroll">
        <v-table density="compact" class="audit-table">
          <thead>
            <tr>
              <th class="col-time text-caption font-weight-medium text-medium-emphasis">Time</th>
              <th class="col-event text-caption font-weight-medium text-medium-emphasis">Event</th>
              <th class="col-actor text-caption font-weight-medium text-medium-emphasis d-none d-sm-table-cell">Actor</th>
              <th class="col-entity text-caption font-weight-medium text-medium-emphasis d-none d-md-table-cell">Entity</th>
              <th class="col-data text-caption font-weight-medium text-medium-emphasis d-none d-lg-table-cell">Data</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="ev in store.events"
              :key="ev.id"
              class="audit-row"
            >
              <!-- Time -->
              <td class="col-time">
                <v-tooltip location="right">
                  <template #activator="{ props: ttProps }">
                    <span v-bind="ttProps" class="text-caption text-medium-emphasis text-nowrap">
                      {{ formatRelative(ev.created_at) }}
                    </span>
                  </template>
                  {{ formatISO(ev.created_at) }}
                </v-tooltip>
              </td>

              <!-- Event chip -->
              <td class="col-event">
                <v-chip
                  :color="eventColor(ev.event)"
                  size="x-small"
                  label
                  variant="tonal"
                  class="event-chip"
                >
                  {{ ev.event }}
                </v-chip>
              </td>

              <!-- Actor -->
              <td class="col-actor d-none d-sm-table-cell">
                <span
                  v-if="ev.actor"
                  class="mono text-caption text-medium-emphasis"
                  :title="ev.actor"
                >
                  {{ truncate(ev.actor, 20) }}
                </span>
                <span v-else class="text-medium-emphasis text-caption">—</span>
              </td>

              <!-- Entity (action_id) -->
              <td class="col-entity d-none d-md-table-cell">
                <span
                  v-if="ev.action_id"
                  class="mono text-caption"
                  :title="ev.action_id"
                >
                  {{ truncate(ev.action_id, 20) }}
                </span>
                <span v-else class="text-medium-emphasis text-caption">—</span>
              </td>

              <!-- Data (JSON blob) -->
              <td class="col-data d-none d-lg-table-cell">
                <template v-if="ev.data">
                  <v-tooltip location="bottom" max-width="400">
                    <template #activator="{ props: ttProps }">
                      <span v-bind="ttProps" class="mono text-caption data-preview">
                        {{ truncate(JSON.stringify(ev.data), 55) }}
                      </span>
                    </template>
                    <pre class="data-tooltip-pre">{{ JSON.stringify(ev.data, null, 2) }}</pre>
                  </v-tooltip>
                </template>
                <span v-else class="text-medium-emphasis text-caption">—</span>
              </td>
            </tr>
          </tbody>
        </v-table>
      </div>
    </v-card>

    <!-- Load more -->
    <div v-if="store.hasMore" class="text-center mt-4">
      <v-btn
        variant="outlined"
        size="small"
        :loading="store.loading"
        @click="store.loadMore()"
      >
        Load more
      </v-btn>
    </div>

    <!-- Row count -->
    <div class="text-center text-caption text-medium-emphasis mt-3">
      {{ store.events.length }} event{{ store.events.length !== 1 ? 's' : '' }} loaded
      <template v-if="store.hasMore">· more available</template>
    </div>
  </template>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useAuditStore } from '../stores/audit'
import type { AuditQueryParams } from '../stores/audit'

const store = useAuditStore()

// ─── Filter state ─────────────────────────────────────────────────────────────

const typeFilter = ref('')
const actorFilter = ref('')
const entityFilter = ref('')
const sinceFilter = ref('')
const untilFilter = ref('')

const hasActiveFilters = computed(() =>
  typeFilter.value !== '' ||
  actorFilter.value !== '' ||
  entityFilter.value !== '' ||
  sinceFilter.value !== '' ||
  untilFilter.value !== '',
)

function dateToUnix(dateStr: string, endOfDay = false): number | undefined {
  if (!dateStr) return undefined
  const ts = new Date(dateStr).getTime() / 1000
  return isNaN(ts) ? undefined : Math.floor(ts) + (endOfDay ? 86399 : 0)
}

function buildParams(): AuditQueryParams {
  return {
    type: typeFilter.value || undefined,
    actor: actorFilter.value.trim() || undefined,
    entity_id: entityFilter.value.trim() || undefined,
    since: dateToUnix(sinceFilter.value),
    until: dateToUnix(untilFilter.value, true),
  }
}

function refresh(): void {
  void store.fetchAudit(buildParams())
}

function clearFilters(): void {
  typeFilter.value = ''
  actorFilter.value = ''
  entityFilter.value = ''
  sinceFilter.value = ''
  untilFilter.value = ''
  void store.fetchAudit({})
}

// ─── Filter change handlers ───────────────────────────────────────────────────

// Selects and dates: apply immediately
function onTypeChange(): void {
  void store.fetchAudit(buildParams())
}

function onDateChange(): void {
  void store.fetchAudit(buildParams())
}

// Text fields: debounce to avoid per-keystroke requests
let textFilterTimer: ReturnType<typeof setTimeout> | null = null

function onTextFilterChange(): void {
  if (textFilterTimer !== null) clearTimeout(textFilterTimer)
  textFilterTimer = setTimeout(() => {
    void store.fetchAudit(buildParams())
  }, 400)
}

onUnmounted(() => {
  if (textFilterTimer !== null) clearTimeout(textFilterTimer)
})

// ─── Export ───────────────────────────────────────────────────────────────────

async function doExport(format: 'json' | 'csv'): Promise<void> {
  await store.exportAudit(buildParams(), format)
}

// ─── Event type options ───────────────────────────────────────────────────────

const EVENT_TYPE_OPTIONS: { title: string; value: string }[] = [
  { title: 'All events', value: '' },
  // Category prefix filters
  { title: 'action.* — all action events', value: 'action.' },
  { title: 'key.* — all key events', value: 'key.' },
  { title: 'watcher.* — all watcher events', value: 'watcher.' },
  { title: 'rule.* — all rule events', value: 'rule.' },
  { title: 'channel.* — all channel events', value: 'channel.' },
  { title: 'project.* — all project events', value: 'project.' },
  { title: 'gdpr.* — all GDPR events', value: 'gdpr.' },
  // High-value individual events
  { title: 'action.approved', value: 'action.approved' },
  { title: 'action.rejected', value: 'action.rejected' },
  { title: 'action.expired', value: 'action.expired' },
  { title: 'action.executed', value: 'action.executed' },
  { title: 'action.execute_failed', value: 'action.execute_failed' },
  { title: 'action.created', value: 'action.created' },
  { title: 'action.rule_applied', value: 'action.rule_applied' },
  { title: 'key.created', value: 'key.created' },
  { title: 'key.revoked', value: 'key.revoked' },
  { title: 'gdpr.export', value: 'gdpr.export' },
  { title: 'gdpr.erase', value: 'gdpr.erase' },
  { title: 'project.secret_rotated', value: 'project.secret_rotated' },
]

// ─── Event chip color by category ────────────────────────────────────────────

function eventColor(event: string): string {
  if (event === 'action.approved' || event === 'action.executed') return 'success'
  if (event === 'action.rejected' || event === 'action.execute_failed') return 'error'
  if (event === 'action.expired') return 'warning'
  if (event.startsWith('action.')) return 'primary'
  if (event.startsWith('key.')) return 'deep-orange'
  if (event.startsWith('watcher.')) return 'cyan'
  if (event.startsWith('rule.')) return 'teal'
  if (event.startsWith('channel.')) return 'orange'
  if (event.startsWith('project.')) return 'deep-purple'
  if (event.startsWith('gdpr.')) return 'error'
  return 'grey'
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function formatRelative(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`
  return formatISO(ts).slice(0, 10)
}

function formatISO(ts: number): string {
  return new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

onMounted(() => {
  void store.fetchAudit({})
})
</script>

<style scoped>
/* Filter widths — flex-shrink-capable so they wrap on mobile */
.filter-type {
  flex: 1 1 200px;
  min-width: 160px;
  max-width: 260px;
}

.filter-id {
  flex: 1 1 140px;
  min-width: 120px;
  max-width: 200px;
}

.filter-date {
  flex: 0 1 148px;
  min-width: 130px;
}

/* Table container: lets the table scroll horizontally without widening the page */
.table-scroll {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

/* Column widths */
.col-time   { white-space: nowrap; width: 90px; padding-left: 16px !important; }
.col-event  { white-space: nowrap; width: 200px; }
.col-actor  { white-space: nowrap; width: 160px; }
.col-entity { white-space: nowrap; width: 160px; }
.col-data   { width: auto; }

/* Event name chip: monospace so dots and underscores align */
.event-chip {
  font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
  font-size: 0.68rem;
  letter-spacing: 0;
  max-width: 220px;
}

/* Monospace IDs and data preview */
.mono {
  font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
}

/* Truncated data blob in the cell */
.data-preview {
  cursor: help;
  opacity: 0.8;
}

/* Tooltip JSON formatter */
.data-tooltip-pre {
  font-size: 0.72rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
  font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, monospace;
}

/* Rows: subtle separator, no hover transform (audit log is read-only) */
.audit-row td {
  padding-top: 6px !important;
  padding-bottom: 6px !important;
  vertical-align: middle;
  border-bottom: 1px solid rgba(128, 128, 128, 0.1);
}

.audit-row:last-child td {
  border-bottom: none;
}

/* Table header: a bit more separation from the card edge */
.audit-table thead th {
  padding-top: 10px !important;
  padding-bottom: 10px !important;
  border-bottom: 1px solid rgba(128, 128, 128, 0.15) !important;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.gap-2 { gap: 8px; }
</style>
