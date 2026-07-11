<template>
  <!-- Header -->
  <div class="d-flex align-center mb-4 gap-2">
    <span class="text-h6">Notifications</span>
    <v-spacer />
    <v-btn
      icon="mdi-refresh"
      variant="text"
      size="small"
      title="Refresh"
      aria-label="Refresh channels"
      :loading="store.loading"
      @click="store.fetchChannels()"
    />
    <v-btn
      color="primary"
      variant="flat"
      size="small"
      prepend-icon="mdi-plus"
      @click="openCreate"
    >
      Add channel
    </v-btn>
  </div>

  <!-- Error alert -->
  <v-alert
    v-if="store.error"
    type="error"
    variant="tonal"
    density="compact"
    class="mb-4"
    closable
    @click:close="store.error = null"
  >
    {{ store.error }}
  </v-alert>

  <!-- Loading skeleton on first load -->
  <template v-if="store.loading && store.channels.length === 0">
    <v-skeleton-loader
      v-for="i in 3"
      :key="i"
      type="list-item-two-line"
      class="mb-2"
    />
  </template>

  <!-- Empty state -->
  <v-card
    v-else-if="!store.loading && store.channels.length === 0"
    variant="outlined"
    class="text-center py-10 px-4"
  >
    <v-icon size="44" color="grey-lighten-1" class="mb-3">mdi-bell-plus-outline</v-icon>
    <div class="text-body-1 font-weight-medium">No notification channels yet</div>
    <div class="text-body-2 text-medium-emphasis mt-1 mb-5 mx-auto" style="max-width: 460px">
      Add a channel to get alerted when an action requires your approval. Supports Slack,
      Discord, Telegram, ntfy, email, and generic webhooks.
    </div>
    <v-btn color="primary" variant="flat" prepend-icon="mdi-plus" @click="openCreate">
      Add your first channel
    </v-btn>
  </v-card>

  <!-- Channel list -->
  <template v-else>
    <v-card
      v-for="ch in store.channels"
      :key="ch.id"
      variant="outlined"
      class="channel-card mb-2"
    >
      <v-card-text class="py-3 px-4">
        <div class="d-flex align-start gap-3">
          <!-- Icon -->
          <v-icon
            :color="channelColor(ch.type)"
            size="22"
            class="mt-1 flex-shrink-0"
          >
            {{ channelIcon(ch.type) }}
          </v-icon>

          <!-- Info -->
          <div class="flex-grow-1 min-width-0">
            <div class="d-flex align-center flex-wrap gap-2 mb-1">
              <v-chip
                size="x-small"
                variant="tonal"
                :color="channelColor(ch.type)"
                label
              >
                {{ ch.type }}
              </v-chip>
              <v-chip
                v-if="!ch.enabled"
                size="x-small"
                color="grey"
                variant="tonal"
                label
              >
                disabled
              </v-chip>
              <v-chip
                v-if="ch.fail_count >= 5"
                size="x-small"
                color="error"
                variant="tonal"
                label
              >
                auto-disabled · {{ ch.fail_count }} failures
              </v-chip>
              <v-chip
                v-else-if="ch.fail_count > 0"
                size="x-small"
                color="warning"
                variant="tonal"
                label
              >
                {{ ch.fail_count }} failure{{ ch.fail_count !== 1 ? 's' : '' }}
              </v-chip>
              <span class="text-body-2 font-weight-medium">{{ ch.name }}</span>
            </div>
            <div class="d-flex flex-wrap gap-3 text-caption text-medium-emphasis">
              <span class="d-flex align-center gap-1">
                <v-icon size="12">mdi-clock-outline</v-icon>
                {{ ch.last_fired_at ? 'Last sent ' + formatRelative(ch.last_fired_at) : 'Never sent' }}
              </span>
              <span
                v-if="ch.last_error"
                class="d-flex align-center gap-1 text-error"
              >
                <v-icon size="12">mdi-alert-circle-outline</v-icon>
                {{ ch.last_error }}
              </span>
            </div>
          </div>

          <!-- Per-row actions -->
          <div class="d-flex gap-1 flex-shrink-0">
            <v-btn
              icon="mdi-send-outline"
              size="x-small"
              variant="text"
              title="Send test message"
              aria-label="Send test message"
              :loading="testing.has(ch.id)"
              @click="sendTest(ch)"
            />
            <v-btn
              :icon="ch.enabled ? 'mdi-pause' : 'mdi-play'"
              size="x-small"
              variant="text"
              :color="ch.enabled ? '' : 'success'"
              :title="ch.enabled ? 'Disable' : 'Enable'"
              :aria-label="ch.enabled ? 'Disable channel' : 'Enable channel'"
              :loading="toggling.has(ch.id)"
              @click="toggleEnabled(ch)"
            />
            <v-btn
              icon="mdi-pencil-outline"
              size="x-small"
              variant="text"
              title="Edit"
              aria-label="Edit channel"
              @click="openEdit(ch)"
            />
            <v-btn
              icon="mdi-delete-outline"
              size="x-small"
              variant="text"
              color="error"
              title="Delete"
              aria-label="Delete channel"
              @click="openDeleteConfirm(ch)"
            />
          </div>
        </div>

        <!-- Test result (auto-clears after 5 s) -->
        <div v-if="testResultByChannel.has(ch.id)" class="mt-2">
          <v-alert
            :type="testResultByChannel.get(ch.id)!.ok ? 'success' : 'error'"
            variant="tonal"
            density="compact"
          >
            {{
              testResultByChannel.get(ch.id)!.ok
                ? 'Test message delivered.'
                : (testResultByChannel.get(ch.id)!.error ?? 'Test failed — check the channel config and try again.')
            }}
          </v-alert>
        </div>
      </v-card-text>
    </v-card>
  </template>

  <!-- ─── Add / Edit dialog ─── -->
  <v-dialog v-model="showDialog" max-width="560" scrollable>
    <v-card :title="isEditing ? 'Edit channel' : 'Add notification channel'">
      <v-card-text style="max-height: 75vh; overflow-y: auto">

        <!-- Name -->
        <v-text-field
          v-model="form.name"
          label="Name *"
          variant="outlined"
          density="comfortable"
          class="mb-3"
          :error-messages="formError && !form.name.trim() ? ['Name is required'] : []"
        />

        <!-- Type (locked after creation) -->
        <v-select
          v-model="form.type"
          label="Channel type *"
          variant="outlined"
          density="comfortable"
          :items="channelTypeOptions"
          :disabled="isEditing"
          class="mb-3"
        />

        <!-- ── Slack ── -->
        <template v-if="form.type === 'slack'">
          <v-text-field
            v-model="form.configUrl"
            label="Incoming webhook URL *"
            variant="outlined"
            density="comfortable"
            :placeholder="
              isEditing && secretsAlreadySet.url && !form.configUrl
                ? 'Leave blank to keep current value'
                : 'https://hooks.slack.com/services/...'
            "
            :hint="
              isEditing && secretsAlreadySet.url
                ? 'Already set — leave blank to keep, or paste a new URL to replace.'
                : 'From Slack API → Incoming Webhooks. Stored securely.'
            "
            persistent-hint
            class="mb-4"
          />
        </template>

        <!-- ── Discord ── -->
        <template v-if="form.type === 'discord'">
          <v-text-field
            v-model="form.configUrl"
            label="Webhook URL *"
            variant="outlined"
            density="comfortable"
            :placeholder="
              isEditing && secretsAlreadySet.url && !form.configUrl
                ? 'Leave blank to keep current value'
                : 'https://discord.com/api/webhooks/...'
            "
            :hint="
              isEditing && secretsAlreadySet.url
                ? 'Already set — leave blank to keep, or paste a new URL to replace.'
                : 'From Discord → Server Settings → Integrations → Webhooks.'
            "
            persistent-hint
            class="mb-4"
          />
        </template>

        <!-- ── Telegram ── -->
        <template v-if="form.type === 'telegram'">
          <v-text-field
            v-model="form.configBotToken"
            label="Bot token *"
            variant="outlined"
            density="comfortable"
            :placeholder="
              isEditing && secretsAlreadySet.botToken && !form.configBotToken
                ? 'Leave blank to keep current value'
                : '1234567890:ABCDE...'
            "
            :hint="
              isEditing && secretsAlreadySet.botToken
                ? 'Already set — leave blank to keep, or paste a new token to replace.'
                : 'From BotFather. Format: 1234567890:ABCDE… Stored securely.'
            "
            persistent-hint
            class="mb-3"
          />
          <v-text-field
            v-model="form.configChatId"
            label="Chat ID *"
            variant="outlined"
            density="comfortable"
            placeholder="-1001234567890 or @channelname"
            hint="The channel, group, or user ID to deliver messages to. Max 50 chars."
            persistent-hint
            class="mb-4"
          />
        </template>

        <!-- ── ntfy ── -->
        <template v-if="form.type === 'ntfy'">
          <v-text-field
            v-model="form.configUrl"
            label="Server URL *"
            variant="outlined"
            density="comfortable"
            :placeholder="
              isEditing && secretsAlreadySet.url && !form.configUrl
                ? 'Leave blank to keep current value'
                : 'https://ntfy.sh'
            "
            :hint="
              isEditing && secretsAlreadySet.url
                ? 'Already set — leave blank to keep, or paste a new URL to replace.'
                : 'Your ntfy server root (e.g. https://ntfy.sh). Stored securely for self-hosted instances.'
            "
            persistent-hint
            class="mb-3"
          />
          <v-text-field
            v-model="form.configTopic"
            label="Topic *"
            variant="outlined"
            density="comfortable"
            placeholder="impri-alerts"
            hint="Letters, numbers, underscores, hyphens, slashes only. Max 64 chars."
            persistent-hint
            class="mb-4"
          />
        </template>

        <!-- ── Email ── -->
        <template v-if="form.type === 'email'">
          <v-text-field
            v-model="form.configAddress"
            label="Email address *"
            type="email"
            variant="outlined"
            density="comfortable"
            placeholder="you@example.com"
            hint="Requires SMTP to be configured on your Impri server (SMTP_HOST env var)."
            persistent-hint
            class="mb-4"
          />
        </template>

        <!-- ── Webhook ── -->
        <template v-if="form.type === 'webhook'">
          <v-text-field
            v-model="form.configUrl"
            label="Endpoint URL *"
            variant="outlined"
            density="comfortable"
            :placeholder="
              isEditing && secretsAlreadySet.url && !form.configUrl
                ? 'Leave blank to keep current value'
                : 'https://your-app.example.com/hooks/impri'
            "
            :hint="
              isEditing && secretsAlreadySet.url
                ? 'Already set — leave blank to keep, or paste a new URL to replace.'
                : 'POST requests with action details are sent here. Stored securely.'
            "
            persistent-hint
            class="mb-3"
          />
          <v-text-field
            v-model="form.configHmacSecret"
            label="HMAC secret (optional)"
            variant="outlined"
            density="comfortable"
            :placeholder="
              isEditing && secretsAlreadySet.hmacSecret && !form.configHmacSecret
                ? 'Leave blank to keep current value'
                : 'A random secret, 16–256 characters'
            "
            :hint="
              isEditing && secretsAlreadySet.hmacSecret
                ? 'Already set — leave blank to keep, or enter a new secret to replace.'
                : 'When set, requests are signed via X-Impri-Signature (HMAC-SHA256). Min 16 chars.'
            "
            persistent-hint
            class="mb-4"
          />
        </template>

        <!-- Digest window -->
        <v-select
          v-model="form.digestWindowSec"
          label="Notification grouping"
          variant="outlined"
          density="comfortable"
          :items="digestWindowOptions"
          hint="Actions within this window are grouped into one message, reducing noise on busy projects."
          persistent-hint
          class="mb-3"
        />

        <!-- Enabled toggle -->
        <v-switch
          v-model="form.enabled"
          label="Enabled"
          color="primary"
          inset
          density="comfortable"
          hide-details
          class="mb-2"
        />

        <!-- Validation error -->
        <v-alert
          v-if="formError"
          type="error"
          variant="tonal"
          density="compact"
          class="mt-4"
        >
          {{ formError }}
        </v-alert>
      </v-card-text>

      <v-card-actions class="pa-3">
        <v-btn variant="text" :disabled="saving" @click="closeDialog">Cancel</v-btn>
        <v-spacer />
        <v-btn
          color="primary"
          variant="flat"
          :loading="saving"
          @click="submitDialog"
        >
          {{ isEditing ? 'Save changes' : 'Add channel' }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <!-- ─── Delete confirm dialog ─── -->
  <v-dialog v-model="showDeleteConfirm" max-width="400">
    <v-card>
      <v-card-title>Delete channel?</v-card-title>
      <v-card-text>
        <strong>{{ deletingChannel?.name }}</strong> will be permanently deleted.
        This cannot be undone.
      </v-card-text>
      <v-card-actions class="pa-3">
        <v-btn variant="text" :disabled="deleting" @click="showDeleteConfirm = false">
          Cancel
        </v-btn>
        <v-spacer />
        <v-btn color="error" variant="flat" :loading="deleting" @click="confirmDelete">
          Delete
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import type { NotificationChannel, ChannelType, UpdateChannelRequest } from '../types'
import { useChannelsStore } from '../stores/channels'
import { ApiClientError } from '../api/client'

const store = useChannelsStore()

// ─── Channel type metadata ────────────────────────────────────────────────────

const CHANNEL_ICONS: Record<ChannelType, string> = {
  slack: 'mdi-slack',
  discord: 'mdi-discord',
  telegram: 'mdi-telegram',
  ntfy: 'mdi-bell-ring-outline',
  email: 'mdi-email-outline',
  webhook: 'mdi-webhook',
}

const CHANNEL_COLORS: Record<ChannelType, string> = {
  slack: 'purple',
  discord: 'indigo',
  telegram: 'blue',
  ntfy: 'orange',
  email: 'teal',
  webhook: 'blue-grey',
}

function channelIcon(type: ChannelType): string {
  return CHANNEL_ICONS[type] ?? 'mdi-bell-outline'
}

function channelColor(type: ChannelType): string {
  return CHANNEL_COLORS[type] ?? 'grey'
}

function formatRelative(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

/** Returns true when the config value is a masked secret (starts with ****). */
function isMasked(v: string | undefined): boolean {
  return typeof v === 'string' && v.startsWith('****')
}

// ─── Toggle enabled ──────────────────────────────────────────────────────────

const toggling = ref(new Set<string>())

async function toggleEnabled(ch: NotificationChannel): Promise<void> {
  toggling.value.add(ch.id)
  try {
    await store.updateChannel(ch.id, { enabled: !ch.enabled })
  } catch (err) {
    store.error = err instanceof Error ? err.message : 'Failed to update channel'
  } finally {
    toggling.value.delete(ch.id)
  }
}

// ─── Test send ───────────────────────────────────────────────────────────────

const testing = ref(new Set<string>())
const testResultByChannel = ref(new Map<string, { ok: boolean; error?: string }>())

async function sendTest(ch: NotificationChannel): Promise<void> {
  testing.value.add(ch.id)
  testResultByChannel.value.delete(ch.id)
  try {
    const result = await store.testChannel(ch.id)
    testResultByChannel.value.set(ch.id, { ok: result.ok, error: result.error })
  } catch (err) {
    testResultByChannel.value.set(ch.id, {
      ok: false,
      error: err instanceof Error ? err.message : 'Test failed',
    })
  } finally {
    testing.value.delete(ch.id)
    // Auto-clear the inline result after 5 seconds
    setTimeout(() => {
      testResultByChannel.value.delete(ch.id)
    }, 5000)
  }
}

// ─── Delete ──────────────────────────────────────────────────────────────────

const showDeleteConfirm = ref(false)
const deletingChannel = ref<NotificationChannel | null>(null)
const deleting = ref(false)

function openDeleteConfirm(ch: NotificationChannel): void {
  deletingChannel.value = ch
  showDeleteConfirm.value = true
}

async function confirmDelete(): Promise<void> {
  if (!deletingChannel.value) return
  deleting.value = true
  try {
    await store.deleteChannel(deletingChannel.value.id)
    showDeleteConfirm.value = false
    deletingChannel.value = null
  } catch (err) {
    store.error = err instanceof Error ? err.message : 'Failed to delete channel'
  } finally {
    deleting.value = false
  }
}

// ─── Create / Edit form ──────────────────────────────────────────────────────

const channelTypeOptions: { title: string; value: ChannelType }[] = [
  { title: 'Slack', value: 'slack' },
  { title: 'Discord', value: 'discord' },
  { title: 'Telegram', value: 'telegram' },
  { title: 'ntfy', value: 'ntfy' },
  { title: 'Email', value: 'email' },
  { title: 'Webhook', value: 'webhook' },
]

const digestWindowOptions = [
  { title: '10 seconds', value: 10 },
  { title: '1 minute (default)', value: 60 },
  { title: '5 minutes', value: 300 },
  { title: '15 minutes', value: 900 },
  { title: '30 minutes', value: 1800 },
  { title: '1 hour', value: 3600 },
]

interface FormState {
  name: string
  type: ChannelType
  enabled: boolean
  digestWindowSec: number
  /** Slack / Discord / ntfy / Webhook URL field */
  configUrl: string
  /** Telegram bot token (secret) */
  configBotToken: string
  /** Telegram chat_id (not secret) */
  configChatId: string
  /** ntfy topic (not secret) */
  configTopic: string
  /** Email address (not secret) */
  configAddress: string
  /** Webhook optional HMAC secret */
  configHmacSecret: string
}

function emptyForm(): FormState {
  return {
    name: '',
    type: 'slack',
    enabled: true,
    digestWindowSec: 60,
    configUrl: '',
    configBotToken: '',
    configChatId: '',
    configTopic: '',
    configAddress: '',
    configHmacSecret: '',
  }
}

const showDialog = ref(false)
const isEditing = ref(false)
const editingChannel = ref<NotificationChannel | null>(null)
const form = reactive<FormState>(emptyForm())
const formError = ref<string | null>(null)
const saving = ref(false)

/** Tracks which secret fields are already set in edit mode so we can show hints. */
const secretsAlreadySet = ref({ url: false, botToken: false, hmacSecret: false })

function openCreate(): void {
  Object.assign(form, emptyForm())
  isEditing.value = false
  editingChannel.value = null
  formError.value = null
  secretsAlreadySet.value = { url: false, botToken: false, hmacSecret: false }
  showDialog.value = true
}

function openEdit(ch: NotificationChannel): void {
  isEditing.value = true
  editingChannel.value = ch
  formError.value = null

  // Reset all fields to defaults before filling from the channel record
  Object.assign(form, emptyForm())
  form.name = ch.name
  form.type = ch.type
  form.enabled = ch.enabled
  form.digestWindowSec = ch.digest_window_sec

  // Reset secret trackers
  secretsAlreadySet.value = { url: false, botToken: false, hmacSecret: false }

  // Pre-fill non-secret fields; track which secrets are already set (masked)
  switch (ch.type) {
    case 'slack':
    case 'discord':
      secretsAlreadySet.value.url = isMasked(ch.config.url)
      break
    case 'telegram':
      secretsAlreadySet.value.botToken = isMasked(ch.config.bot_token)
      form.configChatId = ch.config.chat_id ?? ''
      break
    case 'ntfy':
      secretsAlreadySet.value.url = isMasked(ch.config.url)
      form.configTopic = ch.config.topic ?? ''
      break
    case 'email':
      form.configAddress = ch.config.address ?? ''
      break
    case 'webhook':
      secretsAlreadySet.value.url = isMasked(ch.config.url)
      secretsAlreadySet.value.hmacSecret = isMasked(ch.config.hmac_secret)
      break
  }

  showDialog.value = true
}

function closeDialog(): void {
  showDialog.value = false
}

function validateForm(): string | null {
  if (!form.name.trim()) return 'Name is required'

  switch (form.type) {
    case 'slack':
    case 'discord': {
      const required = !isEditing.value || !secretsAlreadySet.value.url
      if (required && !form.configUrl.trim()) return 'Webhook URL is required'
      if (form.configUrl.trim() && !/^https?:\/\//i.test(form.configUrl.trim()))
        return 'Webhook URL must start with http:// or https://'
      break
    }
    case 'telegram': {
      const required = !isEditing.value || !secretsAlreadySet.value.botToken
      if (required && !form.configBotToken.trim()) return 'Bot token is required'
      if (form.configBotToken.trim() && !/^\d+:[A-Za-z0-9_-]+$/.test(form.configBotToken.trim()))
        return 'Bot token must be in the format 12345:ABCDE…'
      if (!form.configChatId.trim()) return 'Chat ID is required'
      if (form.configChatId.trim().length > 50) return 'Chat ID must be 50 characters or fewer'
      break
    }
    case 'ntfy': {
      const required = !isEditing.value || !secretsAlreadySet.value.url
      if (required && !form.configUrl.trim()) return 'Server URL is required'
      if (form.configUrl.trim() && !/^https?:\/\//i.test(form.configUrl.trim()))
        return 'Server URL must start with http:// or https://'
      if (!form.configTopic.trim()) return 'Topic is required'
      if (!/^[A-Za-z0-9_/-]{1,64}$/.test(form.configTopic.trim()))
        return 'Topic may only contain letters, numbers, underscores, hyphens, slashes (max 64 chars)'
      break
    }
    case 'email': {
      if (!form.configAddress.trim()) return 'Email address is required'
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.configAddress.trim()))
        return 'Enter a valid email address'
      break
    }
    case 'webhook': {
      const required = !isEditing.value || !secretsAlreadySet.value.url
      if (required && !form.configUrl.trim()) return 'Endpoint URL is required'
      if (form.configUrl.trim() && !/^https?:\/\//i.test(form.configUrl.trim()))
        return 'Endpoint URL must start with http:// or https://'
      if (form.configHmacSecret.trim()) {
        const len = form.configHmacSecret.trim().length
        if (len < 16 || len > 256) return 'HMAC secret must be 16–256 characters'
      }
      break
    }
  }

  return null
}

/**
 * Build the config object to send. For create: all required fields included.
 * For edit (PATCH): secret fields only included when the user typed a new value;
 * non-secret fields always included so they can be updated independently.
 */
function buildConfig(): Record<string, string> {
  const config: Record<string, string> = {}
  switch (form.type) {
    case 'slack':
    case 'discord':
      if (form.configUrl.trim()) config.url = form.configUrl.trim()
      break
    case 'telegram':
      if (form.configBotToken.trim()) config.bot_token = form.configBotToken.trim()
      config.chat_id = form.configChatId.trim()
      break
    case 'ntfy':
      if (form.configUrl.trim()) config.url = form.configUrl.trim()
      config.topic = form.configTopic.trim()
      break
    case 'email':
      config.address = form.configAddress.trim()
      break
    case 'webhook':
      if (form.configUrl.trim()) config.url = form.configUrl.trim()
      if (form.configHmacSecret.trim()) config.hmac_secret = form.configHmacSecret.trim()
      break
  }
  return config
}

async function submitDialog(): Promise<void> {
  const validationErr = validateForm()
  if (validationErr) {
    formError.value = validationErr
    return
  }
  formError.value = null
  saving.value = true

  try {
    const config = buildConfig()

    if (isEditing.value && editingChannel.value) {
      const patch: UpdateChannelRequest = {
        name: form.name.trim(),
        enabled: form.enabled,
        digest_window_sec: form.digestWindowSec,
      }
      // Only send config when there are values to merge (avoids a no-op PATCH on config)
      if (Object.keys(config).length > 0) {
        patch.config = config
      }
      await store.updateChannel(editingChannel.value.id, patch)
    } else {
      await store.createChannel({
        name: form.name.trim(),
        type: form.type,
        config,
        enabled: form.enabled,
        digest_window_sec: form.digestWindowSec,
      })
    }

    showDialog.value = false
  } catch (err) {
    if (err instanceof ApiClientError) {
      if (err.body.issues && err.body.issues.length > 0) {
        formError.value = err.body.issues.map((i) => i.message).join('; ')
      } else {
        formError.value = err.body.message ?? err.message
      }
    } else {
      formError.value = err instanceof Error ? err.message : 'Failed to save channel'
    }
  } finally {
    saving.value = false
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

onMounted(() => {
  void store.fetchChannels()
})
</script>

<style scoped>
.channel-card {
  border-left: 3px solid transparent;
}

.min-width-0 {
  min-width: 0;
}

.gap-1 { gap: 4px; }
.gap-2 { gap: 8px; }
.gap-3 { gap: 12px; }
</style>
