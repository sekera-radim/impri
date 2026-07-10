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
              <code class="text-primary">im_</code> and is shown once when the server
              starts for the first time.
            </p>

            <v-form @submit.prevent="handleSubmit">
              <v-text-field
                v-model="keyInput"
                label="API Key"
                placeholder="im_..."
                type="password"
                variant="outlined"
                density="comfortable"
                autocomplete="current-password"
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
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const keyInput = ref('')

async function handleSubmit(): Promise<void> {
  const key = keyInput.value.trim()
  if (!key) return
  await auth.login(key)
}
</script>
