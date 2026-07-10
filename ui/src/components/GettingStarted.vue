<template>
  <v-card class="mb-4" variant="outlined">
    <v-card-text>
      <div class="d-flex align-center gap-2 mb-2">
        <v-icon color="primary">mdi-rocket-launch-outline</v-icon>
        <span class="text-subtitle-1 font-weight-bold">Welcome to Impri</span>
        <v-spacer />
        <v-btn icon="mdi-close" size="x-small" variant="text" title="Dismiss" @click="dismiss" />
      </div>

      <p class="text-body-2 text-medium-emphasis mb-4">
        Impri is a human approval step for AI agents and automations. Something
        creates a request, you review it here and approve or reject — and only
        then does it run. Impri never acts on its own.
      </p>

      <v-row dense class="mb-1">
        <v-col v-for="(s, i) in steps" :key="i" cols="12" sm="4">
          <div class="d-flex gap-3">
            <div class="step-num">{{ i + 1 }}</div>
            <div>
              <div class="text-body-2 font-weight-medium">{{ s.title }}</div>
              <div class="text-caption text-medium-emphasis">{{ s.body }}</div>
            </div>
          </div>
        </v-col>
      </v-row>

      <div class="d-flex flex-wrap gap-2 mt-4">
        <v-btn
          color="primary"
          variant="flat"
          prepend-icon="mdi-flask-outline"
          :loading="sending"
          @click="sendTest"
        >
          Send a test approval
        </v-btn>
        <v-btn variant="outlined" prepend-icon="mdi-eye-plus-outline" @click="emit('go-watchers')">
          Set up a watcher — no code
        </v-btn>
        <v-btn variant="text" prepend-icon="mdi-code-tags" @click="showQuickstart = !showQuickstart">
          Connect an agent
        </v-btn>
      </div>

      <v-alert
        v-if="error"
        type="error"
        variant="tonal"
        density="compact"
        class="mt-3"
        closable
        @click:close="error = null"
      >
        {{ error }}
      </v-alert>

      <v-expand-transition>
        <div v-if="showQuickstart" class="mt-4">
          <p class="text-body-2 font-weight-medium mb-1">Send an approval from anything — curl:</p>
          <div class="code-wrap">
            <v-btn class="code-copy" icon="mdi-content-copy" size="x-small" variant="text" title="Copy" @click="copy(curlSnippet)" />
            <pre class="code-block">{{ curlSnippet }}</pre>
          </div>

          <p class="text-body-2 font-weight-medium mb-1 mt-4">
            Or let an AI agent (Claude &amp; others) ask for approval — MCP config:
          </p>
          <div class="code-wrap">
            <v-btn class="code-copy" icon="mdi-content-copy" size="x-small" variant="text" title="Copy" @click="copy(mcpSnippet)" />
            <pre class="code-block">{{ mcpSnippet }}</pre>
          </div>

          <p class="text-caption text-medium-emphasis mt-2">
            Use an API key that starts with <code>im_</code> (the same kind you signed in with).
          </p>
        </div>
      </v-expand-transition>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAuthStore } from '../stores/auth'

const emit = defineEmits<{
  (e: 'go-watchers'): void
  (e: 'created'): void
  (e: 'dismiss'): void
}>()

const auth = useAuthStore()

const sending = ref(false)
const error = ref<string | null>(null)
const showQuickstart = ref(false)

const steps = [
  { title: 'Something asks', body: 'A watcher or your agent creates an approval request.' },
  { title: 'You decide', body: 'Review it here, then approve or reject — you can edit first.' },
  { title: 'It runs', body: 'Your agent proceeds only after you approve. Never before.' },
]

const rawBase = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/v1'
const fullApiBase = rawBase.startsWith('http') ? rawBase : window.location.origin + rawBase
const apiOrigin = fullApiBase.replace(/\/v1\/?$/, '')

const curlSnippet = computed(
  () => `curl -X POST ${fullApiBase}/actions \\
  -H "Authorization: Bearer im_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"kind":"email.send","title":"Send welcome email","preview":{"format":"markdown","body":"To: user@example.com\\n\\nWelcome aboard!"}}'`,
)

const mcpSnippet = computed(() =>
  JSON.stringify(
    {
      mcpServers: {
        impri: {
          command: 'npx',
          args: ['-y', '@impri/mcp'],
          env: { IMPRI_API_KEY: 'im_YOUR_KEY', IMPRI_BASE_URL: apiOrigin },
        },
      },
    },
    null,
    2,
  ),
)

async function sendTest(): Promise<void> {
  const client = auth.client
  if (!client) {
    error.value = 'Not signed in.'
    return
  }
  sending.value = true
  error.value = null
  try {
    await client.createAction({
      kind: 'demo',
      title: 'Test approval — safe to approve or reject',
      preview: {
        format: 'markdown',
        body:
          'This is a **test approval request**.\n\nApprove or reject it — nothing actually ' +
          'happens either way. Real requests from your agents and watchers will look just like this.',
      },
    })
    emit('created')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to send test approval'
  } finally {
    sending.value = false
  }
}

function copy(text: string): void {
  void navigator.clipboard?.writeText(text)
}

function dismiss(): void {
  localStorage.setItem('impri-onboarding-dismissed', '1')
  emit('dismiss')
}
</script>

<style scoped>
.step-num {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
}

.code-wrap {
  position: relative;
}

.code-copy {
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 1;
}

.code-block {
  margin: 0;
  padding: 12px 14px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid rgba(255, 255, 255, 0.08);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre;
  overflow-x: auto;
}

.gap-2 {
  gap: 8px;
}
.gap-3 {
  gap: 12px;
}
</style>
