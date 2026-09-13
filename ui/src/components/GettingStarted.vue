<template>
  <v-card class="mb-4" variant="outlined">
    <v-card-text>
      <div class="d-flex align-center gap-2 mb-2">
        <v-icon color="primary">mdi-rocket-launch-outline</v-icon>
        <span class="text-subtitle-1 font-weight-bold">Welcome to Impri</span>
        <v-spacer />
        <v-btn icon="mdi-close" size="x-small" variant="text" title="Dismiss" aria-label="Dismiss" @click="dismiss" />
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
            <v-btn
              class="code-copy"
              :icon="copyFeedback === 'curl' ? 'mdi-check' : 'mdi-content-copy'"
              size="x-small"
              variant="text"
              title="Copy"
              aria-label="Copy curl snippet"
              @click="copy(curlSnippet, 'curl')"
            />
            <pre class="code-block">{{ curlSnippet }}</pre>
          </div>

          <p class="text-body-2 font-weight-medium mb-1 mt-4">
            Or let an AI agent ask for approval — connect an MCP client:
          </p>

          <v-tabs v-model="agentTab" density="compact" color="primary" show-arrows class="mb-2">
            <v-tab value="claude">Claude Code</v-tab>
            <v-tab value="codex">Codex CLI</v-tab>
            <v-tab value="cursor">Cursor</v-tab>
            <v-tab value="windsurf">Windsurf</v-tab>
            <v-tab value="json">Generic JSON</v-tab>
          </v-tabs>

          <v-window v-model="agentTab">
            <v-window-item value="claude">
              <div class="code-wrap">
                <v-btn
                  class="code-copy"
                  :icon="copyFeedback === 'claude' ? 'mdi-check' : 'mdi-content-copy'"
                  size="x-small"
                  variant="text"
                  title="Copy"
                  aria-label="Copy Claude Code command"
                  @click="copy(claudeCommand, 'claude')"
                />
                <pre class="code-block">{{ claudeCommand }}</pre>
              </div>
              <p class="text-caption text-medium-emphasis mt-2">
                Verify it loaded with <code>/mcp</code> inside Claude Code.
              </p>
            </v-window-item>

            <v-window-item value="codex">
              <div class="code-wrap">
                <v-btn
                  class="code-copy"
                  :icon="copyFeedback === 'codex' ? 'mdi-check' : 'mdi-content-copy'"
                  size="x-small"
                  variant="text"
                  title="Copy"
                  aria-label="Copy Codex CLI command"
                  @click="copy(codexCommand, 'codex')"
                />
                <pre class="code-block">{{ codexCommand }}</pre>
              </div>
            </v-window-item>

            <v-window-item value="cursor">
              <p class="text-caption text-medium-emphasis mb-1">
                Add to <code>~/.cursor/mcp.json</code> (or <code>.cursor/mcp.json</code> in your project):
              </p>
              <div class="code-wrap">
                <v-btn
                  class="code-copy"
                  :icon="copyFeedback === 'cursor' ? 'mdi-check' : 'mdi-content-copy'"
                  size="x-small"
                  variant="text"
                  title="Copy"
                  aria-label="Copy Cursor MCP config"
                  @click="copy(jsonSnippet, 'cursor')"
                />
                <pre class="code-block">{{ jsonSnippet }}</pre>
              </div>
            </v-window-item>

            <v-window-item value="windsurf">
              <p class="text-caption text-medium-emphasis mb-1">
                Add to <code>~/.codeium/windsurf/mcp_config.json</code>:
              </p>
              <div class="code-wrap">
                <v-btn
                  class="code-copy"
                  :icon="copyFeedback === 'windsurf' ? 'mdi-check' : 'mdi-content-copy'"
                  size="x-small"
                  variant="text"
                  title="Copy"
                  aria-label="Copy Windsurf MCP config"
                  @click="copy(jsonSnippet, 'windsurf')"
                />
                <pre class="code-block">{{ jsonSnippet }}</pre>
              </div>
            </v-window-item>

            <v-window-item value="json">
              <p class="text-caption text-medium-emphasis mb-1">
                Works with any MCP-compatible client (Claude Desktop and others) — paste into
                its <code>mcpServers</code> config:
              </p>
              <div class="code-wrap">
                <v-btn
                  class="code-copy"
                  :icon="copyFeedback === 'json' ? 'mdi-check' : 'mdi-content-copy'"
                  size="x-small"
                  variant="text"
                  title="Copy"
                  aria-label="Copy MCP config JSON"
                  @click="copy(jsonSnippet, 'json')"
                />
                <pre class="code-block">{{ jsonSnippet }}</pre>
              </div>
            </v-window-item>
          </v-window>

          <p class="text-caption text-medium-emphasis mt-2">
            <template v-if="auth.apiKey">
              These snippets already include your current API key — handle copied text like
              the key itself.
            </template>
            <template v-else>
              Replace <code>im_YOUR_KEY</code> with a key that starts with <code>im_</code>.
            </template>
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
const copyFeedback = ref<string | null>(null)

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

const agentTab = ref<'claude' | 'codex' | 'cursor' | 'windsurf' | 'json'>('claude')

// Use the real key when we have one (the user is signed in to see this panel
// at all) so the snippet is ready to paste, not a template to hand-edit.
const apiKeyValue = computed(() => auth.apiKey ?? 'im_YOUR_KEY')

// The MCP server's own default is localhost:8484 (see mcp/src/index.ts), so
// only spell out IMPRI_BASE_URL when pointing anywhere else (e.g. the cloud).
const showBaseUrl = computed(() => apiOrigin !== 'http://localhost:8484')

const claudeCommand = computed(() => {
  const envArgs = [`-e IMPRI_API_KEY=${apiKeyValue.value}`]
  if (showBaseUrl.value) envArgs.push(`-e IMPRI_BASE_URL=${apiOrigin}`)
  return `claude mcp add impri \\\n  ${envArgs.join(' \\\n  ')} \\\n  -- npx -y @impri/mcp`
})

const codexCommand = computed(() => {
  const envArgs = [`--env IMPRI_API_KEY=${apiKeyValue.value}`]
  if (showBaseUrl.value) envArgs.push(`--env IMPRI_BASE_URL=${apiOrigin}`)
  return `codex mcp add impri \\\n  ${envArgs.join(' \\\n  ')} \\\n  -- npx -y @impri/mcp`
})

const jsonSnippet = computed(() =>
  JSON.stringify(
    {
      mcpServers: {
        impri: {
          command: 'npx',
          args: ['-y', '@impri/mcp'],
          env: showBaseUrl.value
            ? { IMPRI_API_KEY: apiKeyValue.value, IMPRI_BASE_URL: apiOrigin }
            : { IMPRI_API_KEY: apiKeyValue.value },
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

function copy(text: string, key: string): void {
  void navigator.clipboard?.writeText(text)
  copyFeedback.value = key
  setTimeout(() => { copyFeedback.value = null }, 1_500)
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
  /* Light-mode defaults */
  background: rgba(0, 0, 0, 0.06);
  border: 1px solid rgba(0, 0, 0, 0.12);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre;
  overflow-x: auto;
}

.v-theme--dark .code-block {
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.gap-2 {
  gap: 8px;
}
.gap-3 {
  gap: 12px;
}
</style>
