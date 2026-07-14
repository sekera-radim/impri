<template>
  <v-card
    :data-kbd-idx="kbdIdx"
    variant="outlined"
    class="action-card mb-2"
    :class="{
      'action-card--pending': action.status === 'pending',
      'action-card--focused': focused,
      'action-card--selected': selected,
    }"
    :style="leftBorderStyle"
    :tabindex="focused ? 0 : -1"
    :aria-selected="selected"
    @click="onCardClick"
  >
    <v-card-text class="py-3 px-4">
      <div class="d-flex align-start gap-3">
        <!-- Checkbox (bulk mode or hover) -->
        <div
          class="card-checkbox-area flex-shrink-0"
          :class="{ 'card-checkbox-area--always-visible': bulkMode || selected }"
          @click.stop
        >
          <v-checkbox
            :model-value="selected"
            density="compact"
            hide-details
            class="card-checkbox"
            :title="hasEditable ? 'Editable — bulk-approve uses the draft as-is; open it to edit before approving' : undefined"
            @update:model-value="onCheckboxChange"
          />
        </div>

        <div class="flex-grow-1 min-width-0">
          <!-- Title + kind -->
          <div class="d-flex align-center flex-wrap gap-2 mb-1">
            <v-chip size="x-small" variant="tonal" color="secondary" label>
              {{ action.kind }}
            </v-chip>
            <v-chip
              v-if="isUntrusted"
              size="x-small"
              variant="tonal"
              color="warning"
              label
              prepend-icon="mdi-alert-outline"
            >
              External content
            </v-chip>
            <v-chip
              v-if="hasEditable && bulkMode"
              size="x-small"
              variant="tonal"
              color="warning"
              label
              prepend-icon="mdi-pencil-lock-outline"
            >
              Has editable fields
            </v-chip>
            <span class="text-body-2 font-weight-medium text-truncate">
              <template v-if="highlight && titleParts.length > 1">
                <template v-for="(part, i) in titleParts" :key="i">
                  <mark v-if="part.match" class="highlight-mark">{{ part.text }}</mark>
                  <template v-else>{{ part.text }}</template>
                </template>
              </template>
              <template v-else>{{ action.title }}</template>
            </span>
          </div>

          <!-- Preview excerpt (plain text + highlight) -->
          <p class="text-body-2 text-medium-emphasis preview-excerpt mb-1">
            <template v-if="highlight && excerptParts.length > 1">
              <template v-for="(part, i) in excerptParts" :key="i">
                <mark v-if="part.match" class="highlight-mark">{{ part.text }}</mark>
                <template v-else>{{ part.text }}</template>
              </template>
            </template>
            <template v-else>{{ previewExcerpt }}</template>
          </p>

          <!-- Meta row -->
          <div class="d-flex align-center flex-wrap gap-3 text-caption text-medium-emphasis">
            <span v-if="action.target_url" class="d-flex align-center gap-1">
              <v-icon size="12">mdi-link</v-icon>
              {{ targetDomain }}
            </span>
            <span v-if="action.expires_at" class="d-flex align-center gap-1" :class="{ 'text-error': isExpiringSoon }">
              <v-icon size="12">mdi-clock-outline</v-icon>
              {{ expiresLabel }}
            </span>
            <span class="d-flex align-center gap-1">
              <v-icon size="12">mdi-calendar-outline</v-icon>
              {{ createdLabel }}
            </span>
          </div>

          <!-- Feature 1: not-idempotent warning badge -->
          <v-chip
            v-if="action.idempotent === false"
            size="x-small"
            variant="tonal"
            color="error"
            label
            class="mt-1"
            prepend-icon="mdi-repeat-off"
          >
            Not idempotent — retrying may duplicate this action
          </v-chip>

          <!-- Feature 3: undo hint -->
          <p
            v-if="action.undo"
            class="text-caption text-medium-emphasis mt-1 mb-0 d-flex align-start gap-1"
          >
            <v-icon size="12" class="mt-px">mdi-undo</v-icon>
            <span><strong>How to undo:</strong> {{ action.undo }}</span>
          </p>

          <!-- Feature 2: result payload receipt -->
          <div
            v-if="(action.status === 'executed' || action.status === 'execute_failed') && action.result_payload"
            class="result-receipt mt-2"
          >
            <p class="text-caption font-weight-medium mb-1 d-flex align-center gap-1">
              <v-icon size="12">mdi-receipt-text-outline</v-icon>
              Result
            </p>
            <div
              v-for="(val, key) in action.result_payload"
              :key="key"
              class="text-caption text-medium-emphasis result-receipt-row"
            >
              <span class="font-weight-medium">{{ key }}:</span>
              {{ Array.isArray(val) ? val.join(', ') : String(val) }}
            </div>
          </div>
        </div>

        <!-- Status chip -->
        <v-chip :color="statusColor" size="small" variant="tonal" class="flex-shrink-0">
          {{ statusLabel }}
        </v-chip>
      </div>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import type { Action, ActionStatus } from '../types'
import { isUntrustedPayload } from '../utils/untrusted'

const props = defineProps<{
  action: Action
  focused?: boolean
  selected?: boolean
  bulkMode?: boolean
  highlight?: string
  kbdIdx?: number
}>()

const emit = defineEmits<{
  click: []
  'toggle-select': [id: string]
}>()

const isUntrusted = computed(() => isUntrustedPayload(props.action.payload))
const hasEditable = computed(() => props.action.editable.length > 0)

// When a watcher action has a color, use it for the left border instead of the
// generic warning color — lets the user identify which watcher created this action.
// When focused the primary border takes precedence (no inline style applied).
const leftBorderStyle = computed(() => {
  if (props.action.color && !props.focused) {
    return { borderLeft: `3px solid ${props.action.color}` }
  }
  return {}
})

function onCardClick(): void {
  if (!props.bulkMode) {
    emit('click')
  } else {
    // In bulk mode, clicking the card body toggles selection. Editable actions are
    // included — bulk-approve uses the draft as-is (open outside bulk to edit first).
    emit('toggle-select', props.action.id)
  }
}

function onCheckboxChange(): void {
  emit('toggle-select', props.action.id)
}

// ── Highlight helpers ─────────────────────────────────────────────────────────

interface TextPart { text: string; match: boolean }

function splitHighlight(text: string, query: string): TextPart[] {
  if (!query.trim()) return [{ text, match: false }]
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`(${escaped})`, 'gi')
  return text.split(regex).map((part, i) => ({ text: part, match: i % 2 === 1 }))
}

const titleParts = computed(() => splitHighlight(props.action.title, props.highlight ?? ''))

const previewExcerpt = computed(() => {
  const body = props.action.preview.body
  return body.length > 120 ? body.slice(0, 120) + '…' : body
})

const excerptParts = computed(() => splitHighlight(previewExcerpt.value, props.highlight ?? ''))

// ── Labels & formatting ───────────────────────────────────────────────────────

const statusLabels: Record<ActionStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  expired: 'Expired',
  executed: 'Executed',
  execute_failed: 'Failed',
}

const statusLabel = computed(() => statusLabels[props.action.status] ?? props.action.status)

const targetDomain = computed(() => {
  if (!props.action.target_url) return ''
  try {
    return new URL(props.action.target_url).hostname
  } catch {
    return props.action.target_url
  }
})

// Reactive second counter so expiry labels update in real time
const now = ref(Date.now())
let nowTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => { nowTimer = setInterval(() => { now.value = Date.now() }, 1_000) })
onUnmounted(() => { if (nowTimer) { clearInterval(nowTimer); nowTimer = null } })
const nowSec = computed(() => Math.floor(now.value / 1_000))

const isExpiringSoon = computed(() => {
  if (!props.action.expires_at) return false
  return props.action.expires_at - nowSec.value < 3600
})

const expiresLabel = computed(() => {
  if (!props.action.expires_at) return ''
  const diffSec = props.action.expires_at - nowSec.value
  if (diffSec <= 0) return 'expired'
  if (diffSec < 60) return `${diffSec}s`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`
  return `${Math.floor(diffSec / 86400)}d`
})

const createdLabel = computed(() => {
  const d = new Date(props.action.created_at * 1000)
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
})

const statusColor = computed(() => {
  switch (props.action.status) {
    case 'pending': return 'warning'
    case 'approved': return 'success'
    case 'rejected': return 'error'
    case 'expired': return 'grey'
    case 'executed': return 'info'
    case 'execute_failed': return 'deep-orange'
    default: return 'grey'
  }
})
</script>

<style scoped>
.action-card {
  cursor: pointer;
  transition: border-color 0.15s;
  position: relative;
}

.action-card:hover {
  border-color: rgba(var(--v-theme-primary), 0.5);
}

.action-card--pending {
  border-left: 3px solid rgb(var(--v-theme-warning));
}

/* Keyboard-focused card: strong primary left border + focus ring */
.action-card--focused {
  border-left: 3px solid rgb(var(--v-theme-primary));
  outline: 2px solid rgba(var(--v-theme-primary), 0.5);
  outline-offset: 1px;
}

/* Selected card: tonal background tint */
.action-card--selected {
  background-color: rgba(var(--v-theme-primary), 0.06);
  border-color: rgba(var(--v-theme-primary), 0.4);
}

.preview-excerpt {
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  font-size: 0.8rem;
}

.min-width-0 {
  min-width: 0;
}

/* Checkbox gutter */
.card-checkbox-area {
  opacity: 0;
  pointer-events: none;
  width: 24px;
  display: flex;
  align-items: center;
  flex-shrink: 0;
  transition: opacity 0.15s;
}

.card-checkbox-area--always-visible,
.action-card:hover .card-checkbox-area,
.action-card--focused .card-checkbox-area {
  opacity: 1;
  pointer-events: auto;
}

.card-checkbox :deep(.v-selection-control) {
  min-height: unset;
}

.highlight-mark {
  background: rgba(var(--v-theme-warning), 0.35);
  border-radius: 2px;
  padding: 0 1px;
  font-style: normal;
}

.result-receipt {
  background: rgba(var(--v-theme-surface-variant), 0.5);
  border-radius: 4px;
  padding: 6px 8px;
}

.result-receipt-row {
  word-break: break-all;
}

.mt-px {
  margin-top: 1px;
}

.gap-1 { gap: 4px; }
.gap-2 { gap: 8px; }
.gap-3 { gap: 12px; }
</style>
