<template>
  <v-dialog v-model="open" max-width="520" persistent>
    <v-card>
      <v-card-title class="pa-6 pb-2">
        <v-icon icon="mdi-shield-key-outline" class="mr-2" color="primary" />
        Recovery code
      </v-card-title>

      <!-- Generating state -->
      <v-card-text v-if="loading" class="pa-6 text-center">
        <v-progress-circular indeterminate color="primary" class="mb-4" />
        <p class="text-body-2 text-medium-emphasis">Generating a new recovery code…</p>
      </v-card-text>

      <!-- Error state -->
      <v-card-text v-else-if="error" class="pa-6">
        <v-alert type="error" variant="tonal" density="compact">{{ error }}</v-alert>
      </v-card-text>

      <!-- Code revealed state -->
      <v-card-text v-else-if="code" class="pa-6">
        <v-alert type="warning" variant="tonal" density="compact" class="mb-4">
          Save this code right now — it will not be shown again. Store it in a password manager.
          It replaces any previous recovery code.
        </v-alert>

        <p class="text-body-2 text-medium-emphasis mb-3">
          If you ever lose all your API keys, use this code at the login screen to regain access.
        </p>

        <div class="d-flex align-center gap-2">
          <code class="recovery-code-box">{{ code }}</code>
          <v-btn
            :icon="copyFeedback ? 'mdi-check' : 'mdi-content-copy'"
            variant="text"
            size="small"
            title="Copy recovery code"
            aria-label="Copy recovery code"
            @click="copyCode"
          />
        </div>
      </v-card-text>

      <!-- Initial prompt (before generation) -->
      <v-card-text v-else class="pa-6">
        <p class="text-body-2 mb-2">
          A recovery code lets you regain access to this project if you lose all your API keys.
        </p>
        <p class="text-body-2 text-medium-emphasis">
          The code will be shown once. Store it somewhere safe, like a password manager.
          Generating a new code invalidates any previous one.
        </p>
      </v-card-text>

      <v-card-actions class="pa-4 pt-0">
        <v-spacer />
        <v-btn v-if="!code && !loading" variant="text" @click="handleClose">Cancel</v-btn>
        <v-btn
          v-if="!code && !loading"
          color="primary"
          variant="flat"
          :loading="loading"
          @click="generate"
        >
          Generate recovery code
        </v-btn>
        <v-btn v-if="code" color="primary" variant="flat" @click="handleClose">
          I've saved the code
        </v-btn>
        <v-btn v-if="error && !loading" variant="text" @click="handleClose">Close</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useAuthStore } from '../stores/auth'

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'generated': []
}>()

const auth = useAuthStore()

const open = ref(props.modelValue)
const loading = ref(false)
const error = ref<string | null>(null)
const code = ref<string | null>(null)
const copyFeedback = ref(false)

watch(() => props.modelValue, (v) => {
  open.value = v
  if (!v) {
    // Reset state when closed
    loading.value = false
    error.value = null
    code.value = null
    copyFeedback.value = false
  }
})

watch(open, (v) => {
  emit('update:modelValue', v)
})

async function generate(): Promise<void> {
  const client = auth.client
  if (!client) return
  loading.value = true
  error.value = null
  try {
    const res = await client.generateRecoveryCode()
    code.value = res.recovery_code
    emit('generated')
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to generate recovery code'
  } finally {
    loading.value = false
  }
}

function copyCode(): void {
  if (code.value) {
    void navigator.clipboard?.writeText(code.value)
    copyFeedback.value = true
    setTimeout(() => { copyFeedback.value = false }, 1_500)
  }
}

function handleClose(): void {
  open.value = false
}
</script>

<style scoped>
.recovery-code-box {
  flex: 1;
  min-width: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  word-break: break-all;
  background: rgba(0, 0, 0, 0.06);
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 8px;
  padding: 8px 10px;
}

.v-theme--dark .recovery-code-box {
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.gap-2 {
  gap: 8px;
}
</style>
