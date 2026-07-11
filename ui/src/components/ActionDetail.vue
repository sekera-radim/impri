<template>
  <v-dialog :model-value="modelValue" max-width="720" scrollable @update:model-value="$emit('update:modelValue', $event)">
    <v-card v-if="action">
      <v-card-title class="d-flex align-center pa-4 pb-2">
        <div class="flex-grow-1 min-width-0">
          <div class="text-h6 text-truncate">{{ action.title }}</div>
          <div class="d-flex align-center flex-wrap gap-2 mt-1">
            <v-chip size="x-small" variant="tonal" color="secondary" label>{{ action.kind }}</v-chip>
            <v-chip :color="statusColor" size="x-small" variant="tonal">{{ statusLabel }}</v-chip>
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
          </div>
        </div>
        <v-btn icon="mdi-close" variant="text" size="small" class="ml-2" title="Close" aria-label="Close" @click="$emit('update:modelValue', false)" />
      </v-card-title>

      <v-divider />

      <v-card-text ref="cardBodyRef" class="pa-4" style="max-height: 70vh; overflow-y: auto">
        <!-- Meta info -->
        <div class="d-flex flex-wrap gap-4 mb-4 text-body-2">
          <!-- Target URL with copy button -->
          <div v-if="action.target_url" class="d-flex align-center gap-1">
            <span class="text-medium-emphasis">Target: </span>
            <a
              :href="action.target_url"
              target="_blank"
              rel="noopener noreferrer"
              class="text-primary"
            >
              <strong>{{ targetDomain }}</strong>{{ targetPath }}
            </a>
            <v-btn
              icon="mdi-content-copy"
              variant="text"
              size="x-small"
              density="compact"
              title="Copy URL"
              aria-label="Copy target URL"
              @click="copyUrl"
            />
          </div>

          <div v-if="action.expires_at">
            <span class="text-medium-emphasis">Expires: </span>
            <span :class="isExpiringSoon ? 'text-error font-weight-medium' : ''">
              {{ expiresLabel }}
            </span>
          </div>

          <div>
            <span class="text-medium-emphasis">Created: </span>
            {{ createdLabel }}
          </div>
        </div>

        <!-- Preview section -->
        <v-card
          variant="tonal"
          :color="isUntrusted ? 'warning' : 'surface-variant'"
          class="mb-4"
        >
          <v-card-title class="text-body-2 font-weight-medium d-flex align-center">
            <v-icon size="16" class="mr-1">mdi-text-box-outline</v-icon>
            Preview
            <v-chip size="x-small" variant="text" class="ml-2 text-medium-emphasis">
              {{ isUntrusted ? 'plain (external)' : action.preview.format }}
            </v-chip>
          </v-card-title>
          <v-card-text class="pt-0">
            <MarkdownPreview
              :format="isUntrusted ? 'plain' : action.preview.format"
              :body="action.preview.body"
            />
          </v-card-text>
        </v-card>

        <!-- Inline editable fields (only for pending actions) -->
        <template v-if="action.status === 'pending' && editableFields.length > 0">
          <div ref="editableSectionRef" class="mb-4">
            <div class="text-body-2 font-weight-medium mb-2 d-flex align-center gap-1">
              <v-icon size="16">mdi-pencil-outline</v-icon>
              Editable fields
            </div>
            <div
              v-for="field in editableFields"
              :key="field"
              class="mb-3"
            >
              <div class="d-flex align-center justify-space-between mb-1">
                <span class="text-caption text-medium-emphasis font-weight-medium">{{ field }}</span>
                <v-btn
                  v-if="!editingFields.has(field)"
                  variant="text"
                  size="x-small"
                  prepend-icon="mdi-pencil"
                  @click="startEdit(field)"
                >
                  Edit
                </v-btn>
                <v-btn
                  v-else
                  variant="text"
                  size="x-small"
                  color="error"
                  prepend-icon="mdi-close"
                  @click="cancelEdit(field)"
                >
                  Cancel
                </v-btn>
              </div>

              <!-- Read-only or editing view -->
              <template v-if="!editingFields.has(field)">
                <div class="field-value text-body-2">{{ editValues[field] ?? originalValues[field] }}</div>
              </template>
              <template v-else>
                <v-textarea
                  v-model="editValues[field]"
                  variant="outlined"
                  density="compact"
                  rows="3"
                  auto-grow
                  hide-details
                  class="mb-2"
                />
                <!-- Diff preview if value changed -->
                <template v-if="fieldHasChanges(field)">
                  <div class="text-caption text-medium-emphasis mb-1">Preview of changes:</div>
                  <MarkdownPreview
                    format="diff"
                    :body="`- ${originalValues[field] ?? ''}\n+ ${editValues[field] ?? ''}`"
                  />
                </template>
              </template>
            </div>
          </div>
        </template>

        <!-- Decision info (if decided) -->
        <template v-if="action.decision">
          <v-card
            variant="tonal"
            :color="action.decision.verdict === 'approve' ? 'success' : 'error'"
            class="mb-4"
          >
            <v-card-text class="py-2">
              <div class="d-flex align-center gap-2 text-body-2">
                <v-icon size="16">
                  {{ action.decision.verdict === 'approve' ? 'mdi-check-circle' : 'mdi-close-circle' }}
                </v-icon>
                <strong class="text-capitalize">{{ action.decision.verdict }}d</strong>
                <span class="text-medium-emphasis">via {{ action.decision.channel ?? 'api' }}</span>
                <span class="text-medium-emphasis">· {{ decisionLabel }}</span>
              </div>

              <template v-if="action.decision.diff">
                <v-divider class="my-2" />
                <p class="text-caption text-medium-emphasis mb-1">Edits applied:</p>
                <MarkdownPreview format="diff" :body="action.decision.diff" />
              </template>
            </v-card-text>
          </v-card>
        </template>

        <!-- Webhook delivery status -->
        <template v-if="action.webhook_delivery">
          <v-card variant="tonal" color="surface-variant" class="mb-4">
            <v-card-title class="text-body-2 font-weight-medium d-flex align-center">
              <v-icon size="16" class="mr-1">mdi-webhook</v-icon>
              Webhook Delivery
            </v-card-title>
            <v-card-text class="pt-0">
              <div class="d-flex flex-wrap gap-4 text-body-2">
                <div>
                  <span class="text-medium-emphasis">Status: </span>
                  <v-chip :color="webhookStatusColor" size="x-small" variant="tonal">
                    {{ action.webhook_delivery.status }}
                  </v-chip>
                </div>
                <div>
                  <span class="text-medium-emphasis">Attempt: </span>
                  {{ action.webhook_delivery.attempt }}
                </div>
                <div v-if="action.webhook_delivery.last_status_code">
                  <span class="text-medium-emphasis">HTTP: </span>
                  {{ action.webhook_delivery.last_status_code }}
                </div>
              </div>
              <p v-if="action.webhook_delivery.last_error" class="text-caption text-error mt-2 mb-0">
                {{ action.webhook_delivery.last_error }}
              </p>
            </v-card-text>
          </v-card>
        </template>

        <!-- Payload section (collapsible) -->
        <template v-if="action.payload !== undefined">
          <PayloadViewer :payload="action.payload" />
        </template>
      </v-card-text>

      <v-divider />

      <v-card-actions class="pa-3">
        <!-- Action ID chip with copy button -->
        <v-chip
          size="x-small"
          variant="outlined"
          class="font-mono mr-2"
          title="Action ID"
        >
          {{ action.id }}
          <v-btn
            icon="mdi-content-copy"
            variant="text"
            size="x-small"
            density="compact"
            class="ml-1"
            aria-label="Copy action ID"
            @click.stop="copyId"
          />
        </v-chip>

        <v-btn
          v-if="action.target_url"
          variant="text"
          size="small"
          :href="action.target_url"
          target="_blank"
          rel="noopener noreferrer"
          prepend-icon="mdi-open-in-new"
        >
          Open target
        </v-btn>
        <v-spacer />

        <template v-if="action.status === 'pending'">
          <v-btn
            color="error"
            variant="tonal"
            size="small"
            prepend-icon="mdi-close"
            @click="openDecision('reject')"
          >
            Reject
          </v-btn>
          <v-btn
            v-if="!hasAnyEdits"
            color="success"
            variant="flat"
            size="small"
            prepend-icon="mdi-check"
            class="ml-2"
            @click="openDecision('approve')"
          >
            Approve
          </v-btn>
          <v-btn
            v-else
            color="success"
            variant="flat"
            size="small"
            prepend-icon="mdi-check-all"
            class="ml-2"
            @click="openDecisionWithEdits"
          >
            Approve with edits
          </v-btn>
        </template>
        <v-alert
          v-else-if="action.status === 'expired'"
          type="warning"
          variant="tonal"
          density="compact"
          class="my-0 text-body-2"
          icon="mdi-clock-alert-outline"
        >
          This action expired before a decision was made.
        </v-alert>
        <v-alert
          v-else-if="action.status === 'approved' || action.status === 'rejected'"
          :type="action.status === 'approved' ? 'success' : 'error'"
          variant="tonal"
          density="compact"
          class="my-0 text-body-2"
        >
          This action was already {{ action.status }}.
        </v-alert>
        <v-alert
          v-else-if="action.status === 'execute_failed'"
          type="error"
          variant="tonal"
          density="compact"
          class="my-0 text-body-2"
          icon="mdi-alert-circle-outline"
        >
          Execution failed — see details above.
        </v-alert>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <DecisionDialog
    v-if="action"
    v-model="showDecisionDialog"
    :action="decisionAction"
    :initial-verdict="pendingVerdictForDialog"
    :initial-edited="initialEditedForDialog"
    @decided="handleDecided"
  />

  <!-- Copied snackbar -->
  <v-snackbar v-model="showCopied" :timeout="1800" location="bottom" color="success">
    {{ copiedMessage }}
  </v-snackbar>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import type { Action, ActionStatus } from '../types'
import MarkdownPreview from './MarkdownPreview.vue'
import PayloadViewer from './PayloadViewer.vue'
import DecisionDialog from './DecisionDialog.vue'
import { isUntrustedPayload } from '../utils/untrusted'
import { getByDotPath } from '../utils/dotPath'

const props = defineProps<{
  modelValue: boolean
  action: Action | null
  openInEditMode?: boolean
  /** When set, immediately opens DecisionDialog with this verdict pre-selected.
   *  Used by keyboard shortcut 'a' for non-editable actions. */
  autoVerdict?: 'approve' | 'reject'
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'decided': [actionId: string]
}>()

// ── Dialog state ──────────────────────────────────────────────────────────────

const showDecisionDialog = ref(false)
const decisionAction = ref<Action | null>(null)
const pendingVerdictForDialog = ref<'approve' | 'reject' | undefined>(undefined)
const initialEditedForDialog = ref<Record<string, unknown> | undefined>(undefined)

// ── Refs ──────────────────────────────────────────────────────────────────────

const cardBodyRef = ref<HTMLElement | null>(null)
const editableSectionRef = ref<HTMLElement | null>(null)

// ── Copy snackbar ─────────────────────────────────────────────────────────────

const showCopied = ref(false)
const copiedMessage = ref('')

async function copyToClipboard(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    copiedMessage.value = label
    showCopied.value = true
  } catch {
    // Fallback for environments without clipboard API
    copiedMessage.value = 'Copy failed'
    showCopied.value = true
  }
}

function copyUrl(): void {
  if (props.action?.target_url) {
    void copyToClipboard(props.action.target_url, 'URL copied!')
  }
}

function copyId(): void {
  if (props.action?.id) {
    void copyToClipboard(props.action.id, 'ID copied!')
  }
}

// ── Inline edit state ─────────────────────────────────────────────────────────

const editableFields = computed(() => props.action?.editable ?? [])
const editingFields = ref<Set<string>>(new Set())
const editValues = ref<Record<string, string>>({})
const originalValues = ref<Record<string, string>>({})

// Re-initialize editable values whenever the action changes
watch(
  () => props.action,
  (action) => {
    editingFields.value = new Set()
    editValues.value = {}
    originalValues.value = {}
    if (!action) return
    for (const field of action.editable) {
      const current = getByDotPath(action as unknown as Record<string, unknown>, field)
      const strVal = typeof current === 'string' ? current : ''
      editValues.value[field] = strVal
      originalValues.value[field] = strVal
    }
  },
  { immediate: true },
)

// Clear edit state when dialog closes
watch(
  () => props.modelValue,
  (open) => {
    if (!open) {
      editingFields.value = new Set()
    }
  },
)

// When openInEditMode changes to true, scroll to editable section
watch(
  () => props.openInEditMode,
  async (val) => {
    if (val && props.modelValue && editableFields.value.length > 0) {
      await nextTick()
      editableSectionRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      // Auto-open editing for the first field
      const firstField = editableFields.value[0]
      if (firstField) startEdit(firstField)
    }
  },
)

// Also handle openInEditMode on mount (dialog already open)
onMounted(async () => {
  if (props.openInEditMode && props.modelValue && editableFields.value.length > 0) {
    await nextTick()
    editableSectionRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    const firstField = editableFields.value[0]
    if (firstField) startEdit(firstField)
  }
  if (props.autoVerdict && props.modelValue && props.action?.status === 'pending') {
    // Immediately fire decision dialog
    openDecision(props.autoVerdict)
  }
})

function startEdit(field: string): void {
  const next = new Set(editingFields.value)
  next.add(field)
  editingFields.value = next
}

function cancelEdit(field: string): void {
  // Restore to original value
  editValues.value[field] = originalValues.value[field] ?? ''
  const next = new Set(editingFields.value)
  next.delete(field)
  editingFields.value = next
}

function fieldHasChanges(field: string): boolean {
  return (editValues.value[field] ?? '') !== (originalValues.value[field] ?? '')
}

const hasAnyEdits = computed(() =>
  editableFields.value.some((f) => fieldHasChanges(f)),
)

// ── Decision flow ─────────────────────────────────────────────────────────────

function openDecision(verdict: 'approve' | 'reject'): void {
  decisionAction.value = props.action
  pendingVerdictForDialog.value = verdict
  initialEditedForDialog.value = undefined
  showDecisionDialog.value = true
}

function openDecisionWithEdits(): void {
  // Collect only fields that actually changed
  const edited: Record<string, unknown> = {}
  for (const field of editableFields.value) {
    if (fieldHasChanges(field)) {
      edited[field] = editValues.value[field]
    }
  }
  decisionAction.value = props.action
  pendingVerdictForDialog.value = 'approve'
  initialEditedForDialog.value = Object.keys(edited).length > 0 ? edited : undefined
  showDecisionDialog.value = true
}

function handleDecided(actionId: string): void {
  showDecisionDialog.value = false
  emit('decided', actionId)
  emit('update:modelValue', false)
}

// ── Meta labels ───────────────────────────────────────────────────────────────

const isUntrusted = computed(() => isUntrustedPayload(props.action?.payload))

const statusLabels: Record<ActionStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  expired: 'Expired',
  executed: 'Executed',
  execute_failed: 'Failed',
}

const statusLabel = computed(() =>
  props.action ? (statusLabels[props.action.status] ?? props.action.status) : '',
)

// Reactive second counter
const now = ref(Date.now())
let nowTimer: ReturnType<typeof setInterval> | null = null
watch(
  () => props.modelValue,
  (open) => {
    if (open && !nowTimer) {
      nowTimer = setInterval(() => { now.value = Date.now() }, 1_000)
    } else if (!open && nowTimer) {
      clearInterval(nowTimer)
      nowTimer = null
    }
  },
  { immediate: true },
)

const nowSec = computed(() => Math.floor(now.value / 1_000))

const isExpiringSoon = computed(() => {
  if (!props.action?.expires_at) return false
  return props.action.expires_at - nowSec.value < 3600
})

const expiresLabel = computed(() => {
  if (!props.action?.expires_at) return ''
  const diffSec = props.action.expires_at - nowSec.value
  if (diffSec <= 0) return 'Expired'
  const d = new Date(props.action.expires_at * 1000)
  const rel = formatRelative(diffSec)
  return `${d.toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} (${rel})`
})

const createdLabel = computed(() => {
  if (!props.action) return ''
  const d = new Date(props.action.created_at * 1000)
  return d.toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
})

const decisionLabel = computed(() => {
  if (!props.action?.decision) return ''
  const d = new Date(props.action.decision.decided_at * 1000)
  return d.toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
})

const targetDomain = computed(() => {
  if (!props.action?.target_url) return ''
  try {
    return new URL(props.action.target_url).hostname
  } catch {
    return props.action.target_url
  }
})

const targetPath = computed(() => {
  if (!props.action?.target_url) return ''
  try {
    const u = new URL(props.action.target_url)
    const rest = u.pathname + u.search
    return rest.length > 60 ? rest.slice(0, 60) + '…' : rest
  } catch {
    return ''
  }
})

const webhookStatusColor = computed(() => {
  switch (props.action?.webhook_delivery?.status) {
    case 'delivered': return 'success'
    case 'failed': return 'error'
    case 'pending': return 'warning'
    default: return 'grey'
  }
})

const statusColor = computed(() => {
  switch (props.action?.status) {
    case 'pending': return 'warning'
    case 'approved': return 'success'
    case 'rejected': return 'error'
    case 'expired': return 'grey'
    case 'executed': return 'info'
    case 'execute_failed': return 'deep-orange'
    default: return 'grey'
  }
})

function formatRelative(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`
  return `${Math.floor(sec / 86400)}d`
}
</script>

<style scoped>
.min-width-0 { min-width: 0; }
.gap-1 { gap: 4px; }
.gap-2 { gap: 8px; }
.gap-4 { gap: 16px; }

.font-mono {
  font-family: 'Roboto Mono', monospace;
  font-size: 0.7rem;
}

.field-value {
  background: rgba(var(--v-theme-surface-variant), 0.5);
  border-radius: 4px;
  padding: 8px 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
