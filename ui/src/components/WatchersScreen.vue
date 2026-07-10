<template>
  <!-- Header -->
  <div class="d-flex align-center mb-4 gap-2">
    <span class="text-h6">Watchers</span>
    <v-spacer />
    <v-btn
      icon="mdi-refresh"
      variant="text"
      size="small"
      title="Refresh"
      aria-label="Refresh watchers"
      :loading="store.loading"
      @click="store.fetchWatchers()"
    />
    <v-btn
      color="primary"
      variant="flat"
      size="small"
      prepend-icon="mdi-plus"
      @click="openCreate()"
    >
      Create
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
  <template v-if="store.loading && store.watchers.length === 0">
    <v-skeleton-loader
      v-for="i in 3"
      :key="i"
      type="list-item-two-line"
      class="mb-2"
    />
  </template>

  <!-- Empty state -->
  <v-card
    v-else-if="!store.loading && store.watchers.length === 0"
    variant="outlined"
    class="text-center py-10 px-4"
  >
    <v-icon size="44" color="grey-lighten-1" class="mb-3">mdi-eye-plus-outline</v-icon>
    <div class="text-body-1 font-weight-medium">No watchers yet</div>
    <div class="text-body-2 text-medium-emphasis mt-1 mb-5 mx-auto" style="max-width: 470px">
      A watcher checks a source on a schedule — a subreddit, an RSS feed, or any web
      page — and drops matching items into your inbox to review. No code needed.
      Pick one to start:
    </div>
    <div class="d-flex flex-wrap justify-center gap-2">
      <v-btn variant="outlined" prepend-icon="mdi-reddit" @click="openCreate('reddit_search')">
        Monitor a subreddit
      </v-btn>
      <v-btn variant="outlined" prepend-icon="mdi-rss" @click="openCreate('rss')">
        Watch an RSS feed
      </v-btn>
      <v-btn variant="outlined" prepend-icon="mdi-file-compare" @click="openCreate('url_diff')">
        Watch a page for changes
      </v-btn>
    </div>
  </v-card>

  <!-- Watcher list -->
  <template v-else>
    <v-card
      v-for="w in store.watchers"
      :key="w.id"
      variant="outlined"
      class="watcher-card mb-2"
    >
      <v-card-text class="py-3 px-4">
        <div class="d-flex align-start gap-3">
          <div class="flex-grow-1 min-width-0">
            <div class="d-flex align-center flex-wrap gap-2 mb-1">
              <v-chip size="x-small" variant="tonal" color="secondary" label>{{ w.kind }}</v-chip>
              <v-chip :color="statusColor(w.status)" size="x-small" variant="tonal" label>
                {{ w.status }}
              </v-chip>
              <span class="text-body-2 font-weight-medium">{{ w.name }}</span>
            </div>
            <div class="d-flex flex-wrap gap-3 text-caption text-medium-emphasis">
              <span class="d-flex align-center gap-1">
                <v-icon size="12">mdi-clock-outline</v-icon>
                Next run: {{ formatNextRun(w.next_run_at) }}
              </span>
              <span
                v-if="w.status === 'degraded' && w.last_error"
                class="d-flex align-center gap-1 text-error"
              >
                <v-icon size="12">mdi-alert-circle-outline</v-icon>
                {{ w.last_error }}
              </span>
            </div>
          </div>

          <!-- Actions -->
          <div class="d-flex gap-1 flex-shrink-0">
            <v-btn
              v-if="w.status === 'paused'"
              icon="mdi-play"
              size="x-small"
              variant="text"
              color="success"
              title="Activate"
              aria-label="Activate watcher"
              :loading="toggling.has(w.id)"
              @click="toggleStatus(w, 'active')"
            />
            <v-btn
              v-else-if="w.status === 'degraded'"
              icon="mdi-refresh"
              size="x-small"
              variant="text"
              color="warning"
              title="Retry"
              aria-label="Retry watcher"
              :loading="toggling.has(w.id)"
              @click="toggleStatus(w, 'active')"
            />
            <v-btn
              v-else
              icon="mdi-pause"
              size="x-small"
              variant="text"
              title="Pause"
              aria-label="Pause watcher"
              :loading="toggling.has(w.id)"
              @click="toggleStatus(w, 'paused')"
            />
            <v-btn
              icon="mdi-delete-outline"
              size="x-small"
              variant="text"
              color="error"
              title="Delete"
              aria-label="Delete watcher"
              @click="openDeleteConfirm(w)"
            />
          </div>
        </div>
      </v-card-text>
    </v-card>
  </template>

  <!-- ─── Create dialog ─── -->
  <v-dialog v-model="showCreate" max-width="600" scrollable>
    <v-card :title="createTitle">
      <v-card-text style="max-height: 75vh; overflow-y: auto">
        <p class="text-body-2 text-medium-emphasis mb-4">
          {{ kindHelp }}
        </p>

        <!-- Name -->
        <v-text-field
          v-model="form.name"
          label="Name *"
          variant="outlined"
          density="comfortable"
          class="mb-3"
          :error-messages="formError && !form.name.trim() ? ['Name is required'] : []"
        />

        <!-- Kind (hidden when opened from a preset button) -->
        <v-select
          v-if="!presetLocked"
          v-model="form.kind"
          label="Type *"
          variant="outlined"
          density="comfortable"
          :items="kindOptions"
          class="mb-3"
        />

        <!-- Config: URL-based kinds -->
        <v-text-field
          v-if="form.kind === 'rss' || form.kind === 'url_diff'"
          v-model="form.configUrl"
          :label="form.kind === 'rss' ? 'Feed URL *' : 'Page URL *'"
          variant="outlined"
          density="comfortable"
          :placeholder="form.kind === 'rss' ? 'https://example.com/feed.xml' : 'https://example.com/pricing'"
          class="mb-3"
        />

        <!-- Config: Reddit search -->
        <template v-if="form.kind === 'reddit_search'">
          <v-text-field
            v-model="form.configSubreddit"
            label="Subreddit *"
            variant="outlined"
            density="comfortable"
            placeholder="AI_Agents"
            prefix="r/"
            class="mb-3"
          />
          <v-text-field
            v-model="form.configQuery"
            label="Search for *"
            variant="outlined"
            density="comfortable"
            placeholder="human in the loop"
            class="mb-3"
          />
        </template>

        <!-- How often -->
        <v-select
          v-model="form.frequency"
          label="How often should it check?"
          variant="outlined"
          density="comfortable"
          :items="frequencyOptions"
          class="mb-3"
        />
        <v-text-field
          v-if="form.frequency === 'custom'"
          v-model="form.customEvery"
          label="Custom interval *"
          variant="outlined"
          density="comfortable"
          placeholder="90m"
          hint='Number + m / h / d — e.g. "90m", "4h", "2d" (min 1m)'
          class="mb-3"
        />

        <!-- Words to look for -->
        <v-combobox
          v-model="form.keywordTags"
          label="Words to look for (optional)"
          variant="outlined"
          density="comfortable"
          multiple
          chips
          closable-chips
          clearable
          hint="Only items containing one of these reach your inbox. Leave empty to get everything. Press Enter after each word."
          persistent-hint
          class="mb-3"
        />

        <!-- Advanced -->
        <v-btn
          variant="text"
          size="small"
          :prepend-icon="showAdvanced ? 'mdi-chevron-up' : 'mdi-chevron-down'"
          class="mb-1"
          @click="showAdvanced = !showAdvanced"
        >
          Advanced options
        </v-btn>
        <v-expand-transition>
          <div v-if="showAdvanced" class="pt-2">
            <v-combobox
              v-model="form.keywordsNone"
              label="Exclude words"
              variant="outlined"
              density="comfortable"
              multiple
              chips
              closable-chips
              clearable
              hint="Items containing any of these are dropped."
              persistent-hint
              class="mb-4"
            />
            <div class="d-flex gap-3">
              <v-text-field
                v-model="form.scheduleJitter"
                label="Jitter"
                variant="outlined"
                density="comfortable"
                placeholder="5m"
                hint="Random delay per run"
                style="flex: 1"
              />
              <v-text-field
                v-model="form.scheduleWindow"
                label="Active window"
                variant="outlined"
                density="comfortable"
                placeholder="06:00-22:00"
                hint="Only run within HH:MM-HH:MM"
                style="flex: 1"
              />
            </div>
          </div>
        </v-expand-transition>

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
        <v-btn variant="text" :disabled="creating" @click="closeCreate">Cancel</v-btn>
        <v-spacer />
        <v-btn
          color="primary"
          variant="flat"
          :loading="creating"
          @click="submitCreate"
        >
          Create watcher
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <!-- ─── Delete confirm dialog ─── -->
  <v-dialog v-model="showDeleteConfirm" max-width="400">
    <v-card>
      <v-card-title>Delete watcher?</v-card-title>
      <v-card-text>
        <strong>{{ deletingWatcher?.name }}</strong> will be permanently deleted along with all
        its collected items. This cannot be undone.
      </v-card-text>
      <v-card-actions class="pa-3">
        <v-btn variant="text" :disabled="deleting" @click="showDeleteConfirm = false">Cancel</v-btn>
        <v-spacer />
        <v-btn color="error" variant="flat" :loading="deleting" @click="confirmDelete">
          Delete
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import type { Watcher, WatcherKind } from '../types'
import { useWatchersStore } from '../stores/watchers'
import { ApiClientError } from '../api/client'

const store = useWatchersStore()

// ─── Status / scheduling helpers ─────────────────────────────────────────────

function statusColor(status: string): string {
  switch (status) {
    case 'active': return 'success'
    case 'paused': return 'grey'
    case 'degraded': return 'error'
    default: return 'grey'
  }
}

function durationToSec(s: string): number {
  const units: Record<string, number> = { m: 60, h: 3600, d: 86400 }
  const unit = s.slice(-1)
  return parseInt(s.slice(0, -1), 10) * (units[unit] ?? 0)
}

function formatNextRun(nextRunAt: number): string {
  const now = Math.floor(Date.now() / 1000)
  const diff = nextRunAt - now
  if (diff <= 0) return 'now'
  if (diff < 60) return `in ${diff}s`
  if (diff < 3600) return `in ${Math.floor(diff / 60)}m`
  if (diff < 86400) return `in ${Math.floor(diff / 3600)}h`
  return `in ${Math.floor(diff / 86400)}d`
}

// ─── Toggle (pause / activate) ───────────────────────────────────────────────

const toggling = ref(new Set<string>())

async function toggleStatus(w: Watcher, target: 'active' | 'paused'): Promise<void> {
  toggling.value.add(w.id)
  try {
    if (target === 'paused') {
      await store.pauseWatcher(w.id)
    } else {
      await store.activateWatcher(w.id)
    }
  } catch (err) {
    store.error = err instanceof Error ? err.message : 'Failed to update watcher'
  } finally {
    toggling.value.delete(w.id)
  }
}

// ─── Delete ──────────────────────────────────────────────────────────────────

const showDeleteConfirm = ref(false)
const deletingWatcher = ref<Watcher | null>(null)
const deleting = ref(false)

function openDeleteConfirm(w: Watcher): void {
  deletingWatcher.value = w
  showDeleteConfirm.value = true
}

async function confirmDelete(): Promise<void> {
  if (!deletingWatcher.value) return
  deleting.value = true
  try {
    await store.deleteWatcher(deletingWatcher.value.id)
    showDeleteConfirm.value = false
    deletingWatcher.value = null
  } catch (err) {
    store.error = err instanceof Error ? err.message : 'Failed to delete watcher'
  } finally {
    deleting.value = false
  }
}

// ─── Create form ─────────────────────────────────────────────────────────────

const kindOptions: { title: string; value: WatcherKind }[] = [
  { title: 'Reddit search', value: 'reddit_search' },
  { title: 'RSS feed', value: 'rss' },
  { title: 'Web page changes', value: 'url_diff' },
]

const frequencyOptions = [
  { title: 'Every 15 minutes', value: '15m' },
  { title: 'Every hour', value: '1h' },
  { title: 'Every 3 hours', value: '3h' },
  { title: 'Every 6 hours', value: '6h' },
  { title: 'Once a day', value: '1d' },
  { title: 'Custom…', value: 'custom' },
]

const kindHelpText: Record<WatcherKind, string> = {
  reddit_search: 'Checks a subreddit for posts matching your search and sends new matches to your inbox to review.',
  rss: 'Checks an RSS/Atom feed and sends new entries to your inbox to review.',
  url_diff: 'Checks a web page on a schedule and notifies you when its content changes.',
}

interface FormState {
  name: string
  kind: WatcherKind
  configUrl: string
  configSubreddit: string
  configQuery: string
  frequency: string
  customEvery: string
  scheduleJitter: string
  scheduleWindow: string
  keywordTags: string[]
  keywordsNone: string[]
}

function emptyForm(): FormState {
  return {
    name: '',
    kind: 'reddit_search',
    configUrl: '',
    configSubreddit: '',
    configQuery: '',
    frequency: '1h',
    customEvery: '',
    scheduleJitter: '',
    scheduleWindow: '',
    keywordTags: [],
    keywordsNone: [],
  }
}

const showCreate = ref(false)
const form = reactive<FormState>(emptyForm())
const formError = ref<string | null>(null)
const creating = ref(false)
const showAdvanced = ref(false)
const presetLocked = ref(false)

const createTitle = computed(() =>
  presetLocked.value ? kindOptions.find((k) => k.value === form.kind)?.title ?? 'New watcher' : 'Create watcher',
)
const kindHelp = computed(() => kindHelpText[form.kind])

function openCreate(preset?: WatcherKind): void {
  Object.assign(form, emptyForm())
  showAdvanced.value = false
  presetLocked.value = false
  // Preset buttons pass a kind + sensible defaults; the header button passes none.
  if (preset && typeof preset === 'string') {
    form.kind = preset
    presetLocked.value = true
    if (preset === 'reddit_search') {
      form.name = 'Reddit — my topic'
      form.frequency = '3h'
    } else if (preset === 'rss') {
      form.name = 'RSS feed'
      form.frequency = '1h'
    } else if (preset === 'url_diff') {
      form.name = 'Page changes'
      form.frequency = '6h'
    }
  }
  formError.value = null
  showCreate.value = true
}

function closeCreate(): void {
  showCreate.value = false
}

function effectiveEvery(): string {
  return (form.frequency === 'custom' ? form.customEvery : form.frequency).trim()
}

function validateForm(): string | null {
  if (!form.name.trim()) return 'Name is required'

  if (form.kind === 'rss' || form.kind === 'url_diff') {
    if (!form.configUrl.trim()) return 'URL is required'
    if (!/^https?:\/\//i.test(form.configUrl.trim())) return 'Only http/https URLs are allowed'
  }

  if (form.kind === 'reddit_search') {
    if (!form.configSubreddit.trim()) return 'Subreddit is required'
    if (!form.configQuery.trim()) return 'Search text is required'
  }

  const every = effectiveEvery()
  if (!every) return 'Interval is required'
  if (!/^\d+[mhd]$/.test(every)) return 'Invalid interval — use e.g. "90m", "4h", "2d"'
  if (durationToSec(every) < 60) return 'Minimum interval is 60 seconds (1m)'

  if (form.scheduleJitter && !/^\d+[mhd]$/.test(form.scheduleJitter.trim())) {
    return 'Invalid jitter — use e.g. "5m", "1h"'
  }
  if (form.scheduleWindow && !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(form.scheduleWindow.trim())) {
    return 'Invalid window — use e.g. "06:00-22:00"'
  }

  return null
}

async function submitCreate(): Promise<void> {
  const validationErr = validateForm()
  if (validationErr) {
    formError.value = validationErr
    return
  }
  formError.value = null
  creating.value = true

  try {
    const config: Record<string, string> = {}
    if (form.kind === 'rss' || form.kind === 'url_diff') config.url = form.configUrl.trim()
    if (form.kind === 'reddit_search') {
      config.subreddit = form.configSubreddit.trim().replace(/^r\//i, '')
      config.query = form.configQuery.trim()
    }

    const schedule: { every: string; jitter?: string; window?: string } = { every: effectiveEvery() }
    if (form.scheduleJitter.trim()) schedule.jitter = form.scheduleJitter.trim()
    if (form.scheduleWindow.trim()) schedule.window = form.scheduleWindow.trim()

    const keywords = form.keywordTags
      .map((t) => t.trim())
      .filter(Boolean)
      .map((pattern) => ({ pattern, points: 1 }))
    const keywordsNone = form.keywordsNone.map((k) => k.trim()).filter(Boolean)

    await store.createWatcher({
      name: form.name.trim(),
      kind: form.kind,
      config,
      keywords,
      keywords_none: keywordsNone,
      // Require at least one keyword match when keywords are given; otherwise accept everything.
      min_score: keywords.length > 0 ? 1 : 0,
      schedule,
    })

    showCreate.value = false
  } catch (err) {
    if (err instanceof ApiClientError) {
      if (err.body.issues && err.body.issues.length > 0) {
        formError.value = err.body.issues.map((i) => i.message).join('; ')
      } else {
        formError.value = err.body.message ?? err.message
      }
    } else {
      formError.value = err instanceof Error ? err.message : 'Failed to create watcher'
    }
  } finally {
    creating.value = false
  }
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

onMounted(() => {
  void store.fetchWatchers()
})
</script>

<style scoped>
.watcher-card {
  border-left: 3px solid transparent;
}

.min-width-0 {
  min-width: 0;
}

.gap-1 { gap: 4px; }
.gap-2 { gap: 8px; }
.gap-3 { gap: 12px; }
</style>
