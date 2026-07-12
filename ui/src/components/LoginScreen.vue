<template>
  <v-container class="fill-height" fluid>
    <v-row justify="center" align="center">
      <v-col cols="12" sm="8" md="5" lg="4">
        <v-card elevation="2" rounded="lg">
          <v-card-title class="pa-6 pb-2">
            <div class="text-h5 font-weight-bold">Impri</div>
            <div class="text-body-2 text-medium-emphasis">Approval Inbox</div>
          </v-card-title>

          <v-card-text class="pa-6">
            <p class="text-body-2 text-medium-emphasis mb-6">
              Enter your operator API key to access the inbox. The key starts with
              <code class="text-primary">im_</code>.
            </p>

            <v-form @submit.prevent="handleSubmit">
              <v-text-field
                v-model="keyInput"
                label="API Key"
                placeholder="im_..."
                type="password"
                variant="outlined"
                density="comfortable"
                autocomplete="off"
                :error-messages="auth.loginError ?? undefined"
                :disabled="auth.loggingIn"
                prepend-inner-icon="mdi-key-outline"
                autofocus
              />

              <v-btn
                type="submit"
                color="primary"
                size="large"
                block
                :loading="auth.loggingIn"
                class="mt-2"
              >
                Sign in
              </v-btn>
            </v-form>

            <div class="text-center mt-5">
              <span class="text-caption text-medium-emphasis">New here?</span>
              <v-btn
                variant="text"
                size="small"
                color="primary"
                :loading="creating"
                @click="createKey"
              >
                Create an API key
              </v-btn>
            </div>

            <div class="text-center mt-1">
              <v-btn
                variant="text"
                size="small"
                color="secondary"
                @click="showRecoverForm = !showRecoverForm"
              >
                {{ showRecoverForm ? 'Back to sign in' : 'Lost your key?' }}
              </v-btn>
            </div>

            <!-- Recovery form -->
            <v-expand-transition>
              <div v-if="showRecoverForm" class="mt-4">
                <v-divider class="mb-4" />
                <p class="text-body-2 text-medium-emphasis mb-4">
                  Enter your project ID and recovery code to get a new API key.
                </p>
                <v-text-field
                  v-model="recoverProjectId"
                  label="Project ID"
                  placeholder="proj_…"
                  variant="outlined"
                  density="comfortable"
                  autocomplete="off"
                  class="mb-2"
                />
                <v-text-field
                  v-model="recoverCode"
                  label="Recovery code"
                  placeholder="imr_…"
                  type="password"
                  variant="outlined"
                  density="comfortable"
                  autocomplete="off"
                  class="mb-2"
                />
                <v-btn
                  color="primary"
                  block
                  :loading="recovering"
                  @click="handleRecover"
                >
                  Recover access
                </v-btn>
                <v-alert
                  v-if="recoverError"
                  type="error"
                  variant="tonal"
                  density="compact"
                  class="mt-3"
                  closable
                  @click:close="recoverError = null"
                >
                  {{ recoverError }}
                </v-alert>
              </div>
            </v-expand-transition>

            <v-alert
              v-if="signupError"
              type="info"
              variant="tonal"
              density="compact"
              class="mt-3"
              closable
              @click:close="signupError = null"
            >
              {{ signupError }}
            </v-alert>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <!-- Recovery success dialog: show new key + new recovery code (both once) -->
    <v-dialog v-model="showRecoverDialog" max-width="520" persistent>
      <v-card>
        <v-card-title>Access restored</v-card-title>
        <v-card-text>
          <v-alert type="warning" variant="tonal" density="compact" class="mb-4">
            Save the new recovery code right now — it will not be shown again.
          </v-alert>
          <p class="text-body-2 text-medium-emphasis mb-2">New API key:</p>
          <div class="d-flex align-center gap-2 mb-4">
            <code class="key-box">{{ recoveredKey }}</code>
            <v-btn
              :icon="copyKeyFeedback ? 'mdi-check' : 'mdi-content-copy'"
              variant="text"
              size="small"
              title="Copy API key"
              @click="copyRecoveredKey"
            />
          </div>
          <p class="text-body-2 text-medium-emphasis mb-2">New recovery code:</p>
          <div class="d-flex align-center gap-2">
            <code class="key-box">{{ recoveredCode }}</code>
            <v-btn
              :icon="copyCodeFeedback ? 'mdi-check' : 'mdi-content-copy'"
              variant="text"
              size="small"
              title="Copy recovery code"
              @click="copyRecoveredCode"
            />
          </div>
        </v-card-text>
        <v-card-actions class="pa-4 pt-0">
          <v-spacer />
          <v-btn color="primary" variant="flat" :loading="auth.loggingIn" @click="continueWithRecoveredKey">
            Continue to inbox
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- New key dialog (shown once) -->
    <v-dialog v-model="showKeyDialog" max-width="480" persistent>
      <v-card>
        <v-card-title>Your new API key</v-card-title>
        <v-card-text>
          <p class="text-body-2 text-medium-emphasis mb-3">
            This is shown once. Copy and store it somewhere safe — it's how you and your
            agents access Impri.
          </p>
          <div class="d-flex align-center gap-2">
            <code class="key-box">{{ newKey }}</code>
            <v-btn
              :icon="copyFeedback ? 'mdi-check' : 'mdi-content-copy'"
              variant="text"
              size="small"
              title="Copy API key"
              aria-label="Copy API key"
              @click="copyKey"
            />
          </div>
        </v-card-text>
        <v-card-actions class="pa-4 pt-0">
          <v-spacer />
          <v-btn color="primary" variant="flat" :loading="auth.loggingIn" @click="continueWithKey">
            Continue to inbox
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useAuthStore } from '../stores/auth'
import { ApiClient, ApiClientError } from '../api/client'

const auth = useAuthStore()
const keyInput = ref('')

const rawBase = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/v1'
const fullApiBase = rawBase.startsWith('http') ? rawBase : window.location.origin + rawBase

const creating = ref(false)
const signupError = ref<string | null>(null)
const newKey = ref('')
const showKeyDialog = ref(false)
const copyFeedback = ref(false)

// Recovery form state
const showRecoverForm = ref(false)
const recoverProjectId = ref('')
const recoverCode = ref('')
const recovering = ref(false)
const recoverError = ref<string | null>(null)

// Recovery success dialog
const showRecoverDialog = ref(false)
const recoveredKey = ref('')
const recoveredCode = ref('')
const copyKeyFeedback = ref(false)
const copyCodeFeedback = ref(false)

async function handleSubmit(): Promise<void> {
  const key = keyInput.value.trim()
  if (!key) return
  await auth.login(key)
}

async function createKey(): Promise<void> {
  creating.value = true
  signupError.value = null
  try {
    const res = await fetch(`${fullApiBase}/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    if (res.status === 404) {
      signupError.value =
        "Self-serve signup isn't enabled here. On a self-hosted server, your key is printed in the server logs on first start."
      return
    }
    if (res.status === 429) {
      signupError.value = 'Too many attempts — please wait a minute and try again.'
      return
    }
    const json = (await res.json()) as { key?: string; message?: string }
    if (!res.ok || !json.key) {
      signupError.value = json.message ?? 'Could not create a key.'
      return
    }
    newKey.value = json.key
    showKeyDialog.value = true
  } catch {
    signupError.value = 'Network error — could not reach the server.'
  } finally {
    creating.value = false
  }
}

function copyKey(): void {
  void navigator.clipboard?.writeText(newKey.value)
  copyFeedback.value = true
  setTimeout(() => { copyFeedback.value = false }, 1_500)
}

async function continueWithKey(): Promise<void> {
  await auth.login(newKey.value)
  showKeyDialog.value = false
}

async function handleRecover(): Promise<void> {
  const projectId = recoverProjectId.value.trim()
  const code = recoverCode.value.trim()
  if (!projectId || !code) return
  recovering.value = true
  recoverError.value = null
  try {
    // Use a temporary ApiClient instance just to call recover (it's unauthenticated).
    const tempClient = new ApiClient('unused')
    const res = await tempClient.recover(projectId, code)
    recoveredKey.value = res.key
    recoveredCode.value = res.recovery_code
    showRecoverDialog.value = true
    showRecoverForm.value = false
  } catch (err) {
    if (err instanceof ApiClientError) {
      if (err.status === 401) {
        recoverError.value = 'Invalid project ID or recovery code.'
      } else if (err.status === 429) {
        recoverError.value = 'Too many attempts — please wait a minute and try again.'
      } else {
        recoverError.value = `Error (${err.status}): ${err.message}`
      }
    } else {
      recoverError.value = 'Could not reach the server.'
    }
  } finally {
    recovering.value = false
  }
}

function copyRecoveredKey(): void {
  void navigator.clipboard?.writeText(recoveredKey.value)
  copyKeyFeedback.value = true
  setTimeout(() => { copyKeyFeedback.value = false }, 1_500)
}

function copyRecoveredCode(): void {
  void navigator.clipboard?.writeText(recoveredCode.value)
  copyCodeFeedback.value = true
  setTimeout(() => { copyCodeFeedback.value = false }, 1_500)
}

async function continueWithRecoveredKey(): Promise<void> {
  await auth.login(recoveredKey.value)
  showRecoverDialog.value = false
}
</script>

<style scoped>
.key-box {
  flex: 1;
  min-width: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  word-break: break-all;
  /* Light-mode defaults */
  background: rgba(0, 0, 0, 0.06);
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 8px;
  padding: 8px 10px;
}

.v-theme--dark .key-box {
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.gap-2 {
  gap: 8px;
}
</style>
