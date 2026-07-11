<template>
  <v-dialog :model-value="modelValue" max-width="560" @update:model-value="$emit('update:modelValue', $event)">
    <v-card :title="action?.title ?? ''">
      <v-card-text>
        <!-- Step 1: choose verdict (only shown when no initialEdited and no initialVerdict) -->
        <template v-if="step === 'choose'">
          <p class="text-body-2 text-medium-emphasis mb-4">
            Choose what to do with this action.
          </p>

          <!-- Editable fields — only shown in choose step when NOT pre-edited in ActionDetail -->
          <template v-if="editableFields.length > 0 && !props.initialEdited">
            <v-divider class="mb-4" />
            <p class="text-caption text-medium-emphasis mb-2">
              You can edit the following fields before approving:
            </p>
            <v-textarea
              v-for="field in editableFields"
              :key="field"
              v-model="editValues[field]"
              :label="field"
              variant="outlined"
              density="comfortable"
              rows="4"
              auto-grow
              class="mb-2"
            />
          </template>

          <!-- When initialEdited is provided, just show a summary -->
          <template v-else-if="props.initialEdited">
            <v-alert type="info" variant="tonal" density="compact" class="mb-2">
              Edits from the detail panel will be applied on approval.
            </v-alert>
          </template>
        </template>

        <!-- Step 2: confirm -->
        <template v-else>
          <p class="text-body-1 mb-2">
            Are you sure you want to
            <strong :class="pendingVerdict === 'approve' ? 'text-success' : 'text-error'">
              {{ pendingVerdict }}
            </strong>
            this action?
          </p>
          <p class="text-body-2 text-medium-emphasis">
            {{ action?.title }}
          </p>
          <template v-if="pendingVerdict === 'approve' && hasEdits">
            <v-divider class="my-3" />
            <p class="text-caption text-medium-emphasis">Edited fields will be included.</p>
          </template>
        </template>

        <!-- Error display -->
        <v-alert
          v-if="errorMessage"
          type="error"
          variant="tonal"
          density="compact"
          class="mt-3"
          closable
          @click:close="errorMessage = null"
        >
          {{ errorMessage }}
        </v-alert>
      </v-card-text>

      <v-card-actions>
        <v-btn variant="text" :disabled="submitting" @click="handleClose">
          Cancel
        </v-btn>
        <v-spacer />

        <template v-if="step === 'choose'">
          <v-btn
            color="error"
            variant="tonal"
            :disabled="submitting"
            prepend-icon="mdi-close"
            @click="chooseVerdict('reject')"
          >
            Reject
          </v-btn>
          <v-btn
            color="success"
            variant="flat"
            :disabled="submitting"
            prepend-icon="mdi-check"
            class="ml-2"
            @click="chooseVerdict('approve')"
          >
            Approve
          </v-btn>
        </template>

        <template v-else>
          <v-btn variant="text" :disabled="submitting" @click="step = 'choose'">
            Back
          </v-btn>
          <v-btn
            :color="pendingVerdict === 'approve' ? 'success' : 'error'"
            variant="flat"
            :loading="submitting"
            class="ml-2"
            @click="confirm"
          >
            {{ pendingVerdict === 'approve' ? 'Confirm approval' : 'Confirm rejection' }}
          </v-btn>
        </template>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { Action } from '../types'
import { useAuthStore } from '../stores/auth'
import { useInboxStore } from '../stores/inbox'
import { buildEditedPayload } from '../utils/dotPath'
import { ApiClientError } from '../api/client'
import { getByDotPath } from '../utils/dotPath'

const props = defineProps<{
  modelValue: boolean
  action: Action | null
  initialVerdict?: 'approve' | 'reject'
  /** Pre-collected edits from ActionDetail's inline edit UI. When provided,
   *  the editable-field textareas in 'choose' step are hidden; we merge these
   *  into the edited payload on confirm instead. */
  initialEdited?: Record<string, unknown>
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'decided': [actionId: string]
}>()

const auth = useAuthStore()
const inbox = useInboxStore()

const step = ref<'choose' | 'confirm'>('choose')
const pendingVerdict = ref<'approve' | 'reject'>('approve')
const submitting = ref(false)
const errorMessage = ref<string | null>(null)

// Edit values keyed by dot-path field name (only used when initialEdited is not provided)
const editValues = ref<Record<string, string>>({})

const editableFields = computed(() => props.action?.editable ?? [])

const hasEdits = computed(() => {
  if (props.initialEdited) {
    return Object.keys(props.initialEdited).length > 0
  }
  return Object.values(editValues.value).some((v) => v !== '')
})

// Pre-populate edit fields when action changes
watch(
  () => props.action,
  (action) => {
    if (!action) return
    const values: Record<string, string> = {}
    for (const field of action.editable) {
      const current = getByDotPath(action as unknown as Record<string, unknown>, field)
      values[field] = typeof current === 'string' ? current : ''
    }
    editValues.value = values
  },
  { immediate: true },
)

// Reset dialog state when it opens; skip to confirm step if a verdict was
// pre-selected by the caller.
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      errorMessage.value = null
      submitting.value = false
      if (props.initialVerdict) {
        pendingVerdict.value = props.initialVerdict
        step.value = 'confirm'
      } else {
        step.value = 'choose'
      }
    }
  },
)

function chooseVerdict(verdict: 'approve' | 'reject'): void {
  pendingVerdict.value = verdict
  step.value = 'confirm'
}

function handleClose(): void {
  emit('update:modelValue', false)
}

async function confirm(): Promise<void> {
  if (!props.action || !auth.client) return

  submitting.value = true
  errorMessage.value = null

  // ── Optimistic update ─────────────────────────────────────────────────────
  // Remove the action from the list immediately so the UX feels snappy.
  // Save original state + index for rollback if the API call fails.
  const originalAction = props.action
  const originalIdx = inbox.actions.findIndex((a) => a.id === originalAction.id)
  const optimisticStatus = pendingVerdict.value === 'approve' ? 'approved' as const : 'rejected' as const
  inbox.updateAction({ ...originalAction, status: optimisticStatus })

  try {
    let edited: Record<string, unknown> | undefined

    if (pendingVerdict.value === 'approve') {
      if (props.initialEdited && Object.keys(props.initialEdited).length > 0) {
        // Edits came from ActionDetail's inline edit UI; validate against whitelist
        edited = buildEditedPayload(props.initialEdited, editableFields.value)
      } else if (editableFields.value.length > 0) {
        // Edits from the choose-step textareas
        const changes: Record<string, unknown> = {}
        for (const field of editableFields.value) {
          const original = getByDotPath(originalAction as unknown as Record<string, unknown>, field)
          const current = editValues.value[field] ?? ''
          if (current !== original) {
            changes[field] = current
          }
        }
        if (Object.keys(changes).length > 0) {
          edited = buildEditedPayload(changes, editableFields.value)
        }
      }
    }

    const result = await auth.client.decide(originalAction.id, {
      decision: pendingVerdict.value,
      edited,
      channel: 'web',
    })

    // Fetch full action to update store with decision details
    try {
      const updatedAction = await auth.client.getAction(originalAction.id)
      inbox.updateAction(updatedAction)
    } catch {
      // Non-critical: optimistic update already removed it from the pending list
    }

    emit('decided', result.id)
    emit('update:modelValue', false)
  } catch (err) {
    // Rollback optimistic update
    if (originalIdx >= 0) {
      inbox.insertAction(originalAction, Math.min(originalIdx, inbox.actions.length))
    } else {
      // Action was not in the list (shouldn't normally happen), just refetch
      void inbox.fetchActions()
    }

    if (err instanceof ApiClientError) {
      if (err.status === 422) {
        const body = err.body
        errorMessage.value = body.message
          ? `${body.message}${body.editable ? ` — editable: ${body.editable.join(', ')}` : ''}`
          : 'Unprocessable entity'
      } else if (err.status === 409) {
        errorMessage.value = `Conflict: ${err.body.message ?? err.body.current_status ?? 'action already decided'}`
      } else {
        errorMessage.value = `Error (${err.status}): ${err.message}`
      }
    } else {
      errorMessage.value = 'Network error. Please try again.'
    }
    step.value = 'choose'
  } finally {
    submitting.value = false
  }
}
</script>
