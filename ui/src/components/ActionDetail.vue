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

      <v-card-text class="pa-4" style="max-height: 70vh; overflow-y: auto">
        <!-- Meta info -->
        <div class="d-flex flex-wrap gap-4 mb-4 text-body-2">
          <div v-if="action.target_url">
            <span class="text-medium-emphasis">Target: </span>
            <a
              :href="action.target_url"
              target="_blank"
              rel="noopener noreferrer"
              class="text-primary"
            >
              <strong>{{ targetDomain }}</strong>{{ targetPath }}
            </a>
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
        <!-- When untrusted, always render as plain text (never trust external markdown) -->
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

              <!-- Show diff if any edits were made -->
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
            color="success"
            variant="flat"
            size="small"
            prepend-icon="mdi-check"
            class="ml-2"
            @click="openDecision('approve')"
          >
            Approve
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
    @decided="handleDecided"
  />
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import type { Action, ActionStatus } from '../types'
import MarkdownPreview from './MarkdownPreview.vue'
import PayloadViewer from './PayloadViewer.vue'
import DecisionDialog from './DecisionDialog.vue'
import { isUntrustedPayload } from '../utils/untrusted'

const props = defineProps<{
  modelValue: boolean
  action: Action | null
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'decided': [actionId: string]
}>()

const showDecisionDialog = ref(false)
const decisionAction = ref<Action | null>(null)
const pendingVerdictForDialog = ref<'approve' | 'reject' | undefined>(undefined)

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

function openDecision(verdict: 'approve' | 'reject'): void {
  decisionAction.value = props.action
  pendingVerdictForDialog.value = verdict
  showDecisionDialog.value = true
}

function handleDecided(actionId: string): void {
  showDecisionDialog.value = false
  emit('decided', actionId)
  emit('update:modelValue', false)
}

// Reactive second counter so expiry labels update in real time
const now = ref(Date.now())
let nowTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => { nowTimer = setInterval(() => { now.value = Date.now() }, 1_000) })
onUnmounted(() => { if (nowTimer) { clearInterval(nowTimer); nowTimer = null } })
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
.gap-2 { gap: 8px; }
.gap-4 { gap: 16px; }
</style>
