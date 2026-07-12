<template>
  <v-dialog :model-value="open" max-width="480" @update:model-value="$emit('close')">
    <v-card>
      <v-card-title class="d-flex align-center">
        <v-icon start size="20">mdi-message-text-outline</v-icon>
        Send feedback
        <v-spacer />
        <v-btn icon="mdi-close" variant="text" size="small" @click="$emit('close')" />
      </v-card-title>

      <v-card-text>
        <template v-if="!sent">
          <p class="text-body-2 text-medium-emphasis mb-3">
            Bugs, rough edges, missing features, or just what you think — it all
            helps. This goes straight to the maintainer.
          </p>

          <div class="mb-3">
            <div class="text-caption text-medium-emphasis mb-1">How's it going? (optional)</div>
            <v-rating v-model="rating" color="amber" density="comfortable" half-increments="false" hover />
          </div>

          <v-textarea
            v-model="message"
            label="Your feedback *"
            variant="outlined"
            rows="4"
            auto-grow
            counter="4000"
            :error-messages="error ? [error] : []"
            class="mb-2"
          />

          <v-text-field
            v-model="contact"
            label="Email or handle to reach you (optional)"
            variant="outlined"
            density="comfortable"
            hint="Only if you'd like a reply. Never shared."
            persistent-hint
          />
        </template>

        <div v-else class="text-center py-6">
          <v-icon size="48" color="success">mdi-check-circle-outline</v-icon>
          <p class="text-body-1 mt-2">Thanks — got it.</p>
        </div>
      </v-card-text>

      <v-card-actions v-if="!sent" class="px-4 pb-4">
        <v-spacer />
        <v-btn variant="text" @click="$emit('close')">Cancel</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          :loading="sending"
          :disabled="!message.trim()"
          @click="submit"
        >
          Send
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useAuthStore } from '../stores/auth'

const props = defineProps<{ open: boolean }>()
defineEmits<{ close: [] }>()

const auth = useAuthStore()
const message = ref('')
const rating = ref(0)
const contact = ref('')
const sending = ref(false)
const sent = ref(false)
const error = ref<string | null>(null)

async function submit(): Promise<void> {
  if (!message.value.trim() || !auth.client) return
  sending.value = true
  error.value = null
  try {
    await auth.client.submitFeedback({
      message: message.value.trim(),
      ...(rating.value > 0 ? { rating: rating.value } : {}),
      ...(contact.value.trim() ? { contact: contact.value.trim() } : {}),
      context: window.location.pathname || '/',
    })
    sent.value = true
    setTimeout(() => close(), 1500)
  } catch {
    error.value = 'Could not send — please try again.'
  } finally {
    sending.value = false
  }
}

function close(): void {
  // Reset for next time after the dialog closes.
  message.value = ''
  rating.value = 0
  contact.value = ''
  sent.value = false
  error.value = null
}

watch(
  () => props.open,
  (open) => {
    if (!open) close()
  },
)
</script>
