<template>
  <!-- Header -->
  <div class="d-flex align-center mb-4 gap-2">
    <span class="text-h6">Watchers</span>
    <v-spacer />
    <v-btn
      icon="mdi-refresh"
      variant="text"
      size="small"
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
              :loading="toggling.has(w.id)"
              @click="toggleStatus(w, 'active')"
            />
            <v-btn
              v-else-if="w.status !== 'degraded'"
              icon="mdi-pause"
              size="x-small"
              variant="text"
              title="Pause"
              :loading="toggling.has(w.id)"
              @click="toggleStatus(w, 'paused')"
            />
            <v-btn
              icon="mdi-delete-outline"
              size="x-small"
              variant="text"
              color="error"
              title="Delete"
              @click="openDeleteConfirm(w)"
            />
          </div>
        </div>
      </v-card-text>
    </v-card>
  </template>

  <!-- ─── Create dialog ─── -->
  <v-dialog v-model="showCreate" max-width="640" scrollable>
    <v-card title="Create watcher">
      <v-card-text style="max-height: 75vh; overflow-y: auto">
        <!-- General -->
        <v-text-field
          v-model="form.name"
          label="Name *"
          variant="outlined"
          density="comfortable"
          class="mb-3"
          :error-messages="formError && !form.name.trim() ? ['Name is required'] : []"
        />

        <v-select
          v-model="form.kind"
          label="Kind *"
          variant="outlined"
          density="comfortable"
          :items="kindOptions"
          class="mb-3"
        />

        <!-- Config: URL-based kinds -->
        <v-text-field
          v-if="form.kind === 'rss' || form.kind === 'url_diff'"
          v-model="form.configUrl"
          label="URL *"
          variant="outlined"
          density="comfortable"
          placeholder="https://example.com/feed.xml"
          hint="Must be an http/https URL"
          class="mb-3"
        />

        <!-- Config: Reddit search -->
        <template v-if="form.kind === 'reddit_search'">
          <v-text-field
            v-model="form.configSubreddit"
            label="Subreddit *"
            variant="outlined"
            density="comfortable"
            placeholder="programming"
            class="mb-3"
          />
          <v-text-field
            v-model="form.configQuery"
            label="Search query *"
            variant="outlined"
            density="comfortable"
            placeholder="AI tools"
            class="mb-3"
          />
        </template>

        <v-divider class="mb-4" />

        <!-- Schedule -->
        <p class="text-body-2 font-weight-medium mb-2">Schedule</p>

        <div class="d-flex gap-3 mb-3">
          <v-text-field
            v-model="form.scheduleEvery"
            label="Interval *"
            variant="outlined"
            density="comfortable"
            placeholder="1h"
            hint="e.g. &quot;30m&quot;, &quot;2h&quot;, &quot;1d&quot; — min 1m"
            style="flex: 1"
          />
          <v-text-field
            v-model="form.scheduleJitter"
            label="Jitter"
            variant="outlined"
            density="comfortable"
            placeholder="5m"
            hint="Random delay added to interval"
            style="flex: 1"
          />
        </div>

        <v-text-field
          v-model="form.scheduleWindow"
          label="Active window"
          variant="outlined"
          density="comfortable"
          placeholder="06:00-22:00"
          hint="Only run within this time window (HH:MM-HH:MM)"
          class="mb-3"
        />

        <v-divider class="mb-4" />

        <!-- Scoring -->
        <p class="text-body-2 font-weight-medium mb-1">Scoring</p>
        <v-text-field
          v-model.number="form.minScore"
          label="Min score"
          type="number"
          variant="outlined"
          density="comfortable"
          :min="0"
          class="mb-3"
          hint="Items below this score are ignored (0 = accept all)"
        />

        <!-- Keywords (include) -->
        <p class="text-body-2 font-weight-medium mb-1">
          Keywords
          <span class="text-caption text-medium-emphasis font-weight-regular ml-1">— each match adds points</span>
        </p>
        <div
          v-for="(kw, idx) in form.keywords"
          :key="idx"
          class="d-flex gap-2 mb-2"
        >
          <v-text-field
            v-model="kw.pattern"
            label="Pattern"
            variant="outlined"
            density="compact"
            style="flex: 1"
            hide-details
          />
          <v-text-field
            v-model.number="kw.points"
            label="Points"
            type="number"
            variant="outlined"
            density="compact"
            :min="1"
            :max="100"
            style="width: 90px; flex-shrink: 0"
            hide-details
          />
          <v-btn
            icon="mdi-close"
            size="x-small"
            variant="text"
            @click="form.keywords.splice(idx, 1)"
          />
        </div>
        <v-btn
          size="x-small"
          variant="text"
          prepend-icon="mdi-plus"
          class="mb-4"
          @click="form.keywords.push({ pattern: '', points: 1 })"
        >
          Add keyword
        </v-btn>

        <!-- Keywords none (exclude) -->
        <p class="text-body-2 font-weight-medium mb-1">
          Exclude keywords
          <span class="text-caption text-medium-emphasis font-weight-regular ml-1">— items matching these are dropped</span>
        </p>
        <div
          v-for="(kw, idx) in form.keywordsNone"
          :key="idx"
          class="d-flex gap-2 mb-2"
        >
          <v-text-field
            v-model="form.keywordsNone[idx]"
            label="Pattern"
            variant="outlined"
            density="compact"
            hide-details
            style="flex: 1"
          />
          <v-btn
            icon="mdi-close"
            size="x-small"
            variant="text"
            @click="form.keywordsNone.splice(idx, 1)"
          />
        </div>
        <v-btn
          size="x-small"
          variant="text"
          prepend-icon="mdi-plus"
          class="mb-2"
          @click="form.keywordsNone.push('')"
        >
          Add exclude keyword
        </v-btn>

        <!-- Validation error -->
        <v-alert
          v-if="formError"
          type="error"
          variant="tonal"
          density="compact"
          class="mt-3"
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
          Create
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
import { ref, reactive, onMounted } from 'vue'
import type { Watcher, WatcherKind, ScoringRule } from '../types'
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
  { title: 'RSS feed', value: 'rss' },
  { title: 'Reddit search', value: 'reddit_search' },
  { title: 'URL diff (change detection)', value: 'url_diff' },
]

interface FormState {
  name: string
  kind: WatcherKind
  configUrl: string
  configSubreddit: string
  configQuery: string
  scheduleEvery: string
  scheduleJitter: string
  scheduleWindow: string
  minScore: number
  keywords: ScoringRule[]
  keywordsNone: string[]
}

function emptyForm(): FormState {
  return {
    name: '',
    kind: 'rss',
    configUrl: '',
    configSubreddit: '',
    configQuery: '',
    scheduleEvery: '1h',
    scheduleJitter: '',
    scheduleWindow: '',
    minScore: 1,
    keywords: [],
    keywordsNone: [],
  }
}

const showCreate = ref(false)
const form = reactive<FormState>(emptyForm())
const formError = ref<string | null>(null)
const creating = ref(false)

function openCreate(preset?: WatcherKind): void {
  Object.assign(form, emptyForm())
  // Preset buttons pass a kind + sensible defaults; the header button passes none.
  if (preset && typeof preset === 'string') {
    form.kind = preset
    if (preset === 'reddit_search') {
      form.name = 'Reddit — my topic'
      form.scheduleEvery = '2h'
    } else if (preset === 'rss') {
      form.name = 'RSS feed'
      form.scheduleEvery = '1h'
    } else if (preset === 'url_diff') {
      form.name = 'Page changes'
      form.scheduleEvery = '6h'
    }
  }
  formError.value = null
  showCreate.value = true
}

function closeCreate(): void {
  showCreate.value = false
}

function validateForm(): string | null {
  if (!form.name.trim()) return 'Name is required'

  if (form.kind === 'rss' || form.kind === 'url_diff') {
    if (!form.configUrl.trim()) return 'URL is required'
    if (!/^https?:\/\//i.test(form.configUrl.trim())) return 'Only http/https URLs are allowed'
  }

  if (form.kind === 'reddit_search') {
    if (!form.configSubreddit.trim()) return 'Subreddit is required'
    if (!form.configQuery.trim()) return 'Search query is required'
  }

  if (!form.scheduleEvery.trim()) return 'Schedule interval is required'
  if (!/^\d+[mhd]$/.test(form.scheduleEvery.trim())) {
    return 'Invalid interval format — use e.g. "30m", "2h", "1d"'
  }
  if (durationToSec(form.scheduleEvery.trim()) < 60) {
    return 'Minimum interval is 60 seconds (1m)'
  }

  if (form.scheduleJitter && !/^\d+[mhd]$/.test(form.scheduleJitter.trim())) {
    return 'Invalid jitter format — use e.g. "5m", "1h"'
  }

  if (form.scheduleWindow && !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(form.scheduleWindow.trim())) {
    return 'Invalid window format — use e.g. "06:00-22:00"'
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
      config.subreddit = form.configSubreddit.trim()
      config.query = form.configQuery.trim()
    }

    const schedule: { every: string; jitter?: string; window?: string } = {
      every: form.scheduleEvery.trim(),
    }
    if (form.scheduleJitter.trim()) schedule.jitter = form.scheduleJitter.trim()
    if (form.scheduleWindow.trim()) schedule.window = form.scheduleWindow.trim()

    await store.createWatcher({
      name: form.name.trim(),
      kind: form.kind,
      config,
      keywords: form.keywords.filter((k) => k.pattern.trim()),
      keywords_none: form.keywordsNone.filter((k) => k.trim()),
      min_score: form.minScore,
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
