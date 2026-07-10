<template>
  <v-dialog :model-value="modelValue" max-width="560" @update:model-value="$emit('update:modelValue', $event)">
    <v-card :title="action?.title ?? ''">
      <v-card-text>
        <!-- Step 1: choose verdict -->
        <template v-if="step === 'choose'">
          <p class="text-body-2 text-medium-emphasis mb-4">
            Choose what to do with this action.
          </p>

          <!-- Editable fields for approve -->
          <template v-if="editableFields.length > 0">
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
            @click="choosVerdict('reject')"
          >
            Reject
          </v-btn>
          <v-btn
            color="success"
            variant="flat"
            :disabled="submitting"
            prepend-icon="mdi-check"
            class="ml-2"
            @click="choosVerdict('approve')"
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
            Confirm {{ pendingVerdict }}
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

// Edit values keyed by dot-path field name
const editValues = ref<Record<string, string>>({})

const editableFields = computed(() => props.action?.editable ?? [])

const hasEdits = computed(() =>
  Object.values(editValues.value).some((v) => v !== ''),
)

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

// Reset dialog state when it opens
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      step.value = 'choose'
      errorMessage.value = null
      submitting.value = false
    }
  },
)

function choosVerdict(verdict: 'approve' | 'reject'): void {
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

  try {
    let edited: Record<string, unknown> | undefined

    if (pendingVerdict.value === 'approve' && editableFields.value.length > 0) {
      const changes: Record<string, unknown> = {}
      for (const field of editableFields.value) {
        const original = getByDotPath(props.action as unknown as Record<string, unknown>, field)
        const current = editValues.value[field] ?? ''
        if (current !== original) {
          changes[field] = current
        }
      }
      if (Object.keys(changes).length > 0) {
        edited = buildEditedPayload(changes, editableFields.value)
      }
    }

    const result = await auth.client.decide(props.action.id, {
      decision: pendingVerdict.value,
      edited,
      channel: 'web',
    })

    // Refresh action in the inbox list
    const updatedAction = await auth.client.getAction(props.action.id)
    inbox.updateAction(updatedAction)

    emit('decided', result.id)
    emit('update:modelValue', false)
  } catch (err) {
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
