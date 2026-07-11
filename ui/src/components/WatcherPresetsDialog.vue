<template>
  <v-dialog
    v-model="show"
    :max-width="step === 'gallery' ? 720 : 600"
    scrollable
    @after-leave="onDialogClosed"
  >
    <v-card>
      <!-- ─── Step 1: Gallery ─────────────────────────────────────────────── -->
      <template v-if="step === 'gallery'">
        <v-card-title class="d-flex align-center px-5 pt-5 pb-1">
          <v-icon color="primary" class="mr-2" size="20">mdi-view-grid-plus-outline</v-icon>
          New watcher
          <v-spacer />
          <v-btn icon="mdi-close" variant="text" size="small" aria-label="Close" @click="show = false" />
        </v-card-title>

        <div class="px-5 pb-3">
          <p class="text-body-2 text-medium-emphasis">
            Pick a source to monitor — then fill in a couple of fields and you're done.
          </p>
        </div>

        <!-- Category filter -->
        <div class="px-4 pb-2 category-scroll">
          <v-chip-group v-model="selectedCategory" color="primary" mandatory>
            <v-chip value="all" size="small" rounded="lg">All</v-chip>
            <v-chip
              v-for="cat in categories"
              :key="cat"
              :value="cat"
              size="small"
              rounded="lg"
            >
              <v-icon :icon="categoryIcon(cat)" size="14" start />
              {{ cat }}
            </v-chip>
          </v-chip-group>
        </div>

        <!-- Preset grid -->
        <v-card-text class="px-4 pt-1 pb-2 gallery-scroll">
          <!-- Loading -->
          <v-row v-if="presetsLoading" dense>
            <v-col v-for="i in 6" :key="i" cols="12" sm="6">
              <v-skeleton-loader type="card" height="90" />
            </v-col>
          </v-row>

          <!-- Error -->
          <v-alert
            v-else-if="presetsError"
            type="error"
            variant="tonal"
            density="compact"
            class="my-2"
          >
            {{ presetsError }}
            <template #append>
              <v-btn variant="text" size="small" @click="loadPresets">Retry</v-btn>
            </template>
          </v-alert>

          <!-- Cards -->
          <v-row v-else dense>
            <v-col
              v-for="preset in filteredPresets"
              :key="preset.id"
              cols="12"
              sm="6"
            >
              <v-card
                variant="outlined"
                class="preset-card h-100"
                tabindex="0"
                role="button"
                :aria-label="`Select ${preset.title}`"
                @click="selectPreset(preset)"
                @keydown.enter="selectPreset(preset)"
                @keydown.space.prevent="selectPreset(preset)"
              >
                <v-card-text class="pa-3">
                  <div class="d-flex align-start" style="gap: 10px">
                    <div
                      class="preset-icon-wrap flex-shrink-0"
                      :style="{ background: categoryIconBg(preset.category) }"
                    >
                      <v-icon :icon="categoryIcon(preset.category)" size="15" color="primary" />
                    </div>
                    <div class="flex-grow-1" style="min-width: 0">
                      <div class="d-flex align-center flex-wrap mb-1" style="gap: 6px">
                        <span class="text-body-2 font-weight-medium preset-title">{{ preset.title }}</span>
                        <v-chip
                          :color="kindColor(preset.kind)"
                          size="x-small"
                          variant="tonal"
                          label
                        >
                          {{ preset.kind }}
                        </v-chip>
                      </div>
                      <p class="text-caption text-medium-emphasis preset-desc">
                        {{ preset.description }}
                      </p>
                    </div>
                    <v-icon size="14" color="primary" class="flex-shrink-0 preset-chevron">
                      mdi-chevron-right
                    </v-icon>
                  </div>
                </v-card-text>
              </v-card>
            </v-col>

            <!-- Empty filtered state -->
            <v-col v-if="filteredPresets.length === 0" cols="12">
              <div class="text-center text-medium-emphasis py-6 text-body-2">
                No presets in this category yet.
              </div>
            </v-col>
          </v-row>
        </v-card-text>

        <v-divider />
        <v-card-actions class="pa-4">
          <v-btn
            variant="text"
            size="small"
            prepend-icon="mdi-tune-variant"
            @click="$emit('open-manual')"
          >
            Custom watcher
          </v-btn>
          <v-spacer />
          <v-btn variant="text" @click="show = false">Cancel</v-btn>
        </v-card-actions>
      </template>

      <!-- ─── Step 2: Configure ───────────────────────────────────────────── -->
      <template v-else-if="step === 'configure' && activePreset">
        <v-card-title class="d-flex align-center px-4 pt-5 pb-1" style="gap: 4px">
          <v-btn
            icon="mdi-arrow-left"
            variant="text"
            size="small"
            aria-label="Back to gallery"
            @click="step = 'gallery'"
          />
          <span class="flex-grow-1 text-body-1 font-weight-medium ml-1">
            {{ activePreset.title }}
          </span>
          <v-chip
            :color="kindColor(activePreset.kind)"
            size="x-small"
            variant="tonal"
            label
            class="flex-shrink-0"
          >
            {{ activePreset.kind }}
          </v-chip>
        </v-card-title>

        <div class="px-5 pb-3 pt-1">
          <p class="text-body-2 text-medium-emphasis">{{ activePreset.description }}</p>
        </div>

        <v-card-text class="px-5 pt-0 pb-2 configure-scroll">
          <!-- Dynamic param fields -->
          <template v-if="activePreset.params.length > 0">
            <v-text-field
              v-for="param in activePreset.params"
              :key="param.name"
              v-model="paramValues[param.name]"
              :label="paramLabel(param)"
              :placeholder="param.example"
              :hint="param.description"
              persistent-hint
              variant="outlined"
              density="comfortable"
              class="mb-5"
              autocomplete="off"
            />
          </template>

          <!-- No-param preset: brief note -->
          <v-alert
            v-else
            type="info"
            variant="tonal"
            density="compact"
            class="mb-4 text-body-2"
          >
            This preset needs no configuration — just name it and set a schedule.
          </v-alert>

          <!-- Name -->
          <v-text-field
            v-model="configName"
            label="Watcher name"
            variant="outlined"
            density="comfortable"
            class="mb-3"
            hint="You can rename it any time."
          />

          <!-- Schedule -->
          <v-select
            v-model="configSchedule"
            label="Check every"
            variant="outlined"
            density="comfortable"
            :items="scheduleOptions"
            class="mb-3"
          />
          <v-text-field
            v-if="configSchedule === 'custom'"
            v-model="configCustomEvery"
            label="Custom interval *"
            variant="outlined"
            density="comfortable"
            placeholder="90m"
            hint='Number + m / h / d — e.g. "90m", "4h", "2d" (min 1m)'
            class="mb-3"
          />

          <!-- Advanced -->
          <v-btn
            variant="text"
            size="small"
            :prepend-icon="showAdvanced ? 'mdi-chevron-up' : 'mdi-chevron-down'"
            class="mb-1 ml-n2"
            @click="showAdvanced = !showAdvanced"
          >
            Advanced options
          </v-btn>
          <v-expand-transition>
            <div v-if="showAdvanced" class="pt-2">
              <div class="d-flex" style="gap: 12px">
                <v-text-field
                  v-model="configJitter"
                  label="Jitter"
                  variant="outlined"
                  density="comfortable"
                  placeholder="5m"
                  hint="Random delay added per run"
                  style="flex: 1"
                />
                <v-text-field
                  v-model="configWindow"
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

          <!-- Error -->
          <v-alert
            v-if="createError"
            type="error"
            variant="tonal"
            density="compact"
            class="mt-4"
          >
            {{ createError }}
          </v-alert>
        </v-card-text>

        <v-card-actions class="pa-4">
          <v-btn variant="text" :disabled="creating" @click="show = false">Cancel</v-btn>
          <v-spacer />
          <v-btn
            color="primary"
            variant="flat"
            :loading="creating"
            @click="submitPreset"
          >
            Create watcher
          </v-btn>
        </v-card-actions>
      </template>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, reactive } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useWatchersStore } from '../stores/watchers'
import { ApiClientError } from '../api/client'
import type { WatcherPreset, WatcherPresetParam, WatcherKind } from '../types'

// ─── Model / emits ───────────────────────────────────────────────────────────

const show = defineModel<boolean>({ default: false })

const emit = defineEmits<{
  'open-manual': []
  created: []
}>()

// ─── Stores ──────────────────────────────────────────────────────────────────

const auth = useAuthStore()
const watchersStore = useWatchersStore()

// ─── Preset catalog ──────────────────────────────────────────────────────────

const presets = ref<WatcherPreset[]>([])
const presetsLoading = ref(false)
const presetsError = ref<string | null>(null)
let catalogFetched = false

async function loadPresets(): Promise<void> {
  const client = auth.client
  if (!client) return
  presetsLoading.value = true
  presetsError.value = null
  try {
    const res = await client.listWatcherPresets()
    presets.value = res.presets
    catalogFetched = true
  } catch (err) {
    presetsError.value = err instanceof Error ? err.message : 'Failed to load preset catalog'
  } finally {
    presetsLoading.value = false
  }
}

// Load once when the dialog first opens; reload on retry.
watch(show, (open) => {
  if (open && !catalogFetched) {
    void loadPresets()
  }
})

// ─── Gallery step ────────────────────────────────────────────────────────────

type Step = 'gallery' | 'configure'
const step = ref<Step>('gallery')

const selectedCategory = ref<string>('all')

const categories = computed<string[]>(() => {
  const seen = new Set<string>()
  const result: string[] = []
  for (const p of presets.value) {
    if (!seen.has(p.category)) {
      seen.add(p.category)
      result.push(p.category)
    }
  }
  return result
})

const filteredPresets = computed<WatcherPreset[]>(() => {
  if (selectedCategory.value === 'all') return presets.value
  return presets.value.filter((p) => p.category === selectedCategory.value)
})

function categoryIcon(cat: string): string {
  const icons: Record<string, string> = {
    Community: 'mdi-account-group-outline',
    Developer: 'mdi-code-braces',
    Content: 'mdi-text-box-multiple-outline',
    Monitoring: 'mdi-eye-check-outline',
    Research: 'mdi-flask-outline',
    News: 'mdi-newspaper-variant-outline',
  }
  return icons[cat] ?? 'mdi-bookmark-outline'
}

function categoryIconBg(cat: string): string {
  // Returns a subtle tinted background for the icon container.
  // Uses CSS vars so it adapts to light/dark automatically.
  const map: Record<string, string> = {
    Community: 'rgba(99,102,241,0.12)',
    Developer: 'rgba(16,185,129,0.12)',
    Content: 'rgba(245,158,11,0.12)',
    Monitoring: 'rgba(59,130,246,0.12)',
    Research: 'rgba(168,85,247,0.12)',
    News: 'rgba(239,68,68,0.12)',
  }
  return map[cat] ?? 'rgba(99,102,241,0.1)'
}

function kindColor(kind: WatcherKind): string {
  switch (kind) {
    case 'rss': return 'orange'
    case 'reddit_search': return 'deep-orange'
    case 'url_diff': return 'cyan'
    default: return 'secondary'
  }
}

// ─── Configure step ──────────────────────────────────────────────────────────

const activePreset = ref<WatcherPreset | null>(null)
const paramValues = reactive<Record<string, string>>({})
const configName = ref('')
const configSchedule = ref('1h')
const configCustomEvery = ref('')
const configJitter = ref('')
const configWindow = ref('')
const showAdvanced = ref(false)
const creating = ref(false)
const createError = ref<string | null>(null)

// Schedule options — includes common intervals; the preset's default is
// auto-selected when the step opens via selectPreset().
const ALL_SCHEDULE_OPTIONS = [
  { title: 'Every 15 minutes', value: '15m' },
  { title: 'Every 30 minutes', value: '30m' },
  { title: 'Every hour', value: '1h' },
  { title: 'Every 3 hours', value: '3h' },
  { title: 'Every 6 hours', value: '6h' },
  { title: 'Every 12 hours', value: '12h' },
  { title: 'Once a day', value: '1d' },
  { title: 'Custom…', value: 'custom' },
]

const scheduleOptions = computed(() => {
  // Always include the preset's default in the list so the select can bind to it.
  const defaultEvery = activePreset.value?.defaultScheduleEvery
  if (defaultEvery && !ALL_SCHEDULE_OPTIONS.find((o) => o.value === defaultEvery)) {
    const label = `Every ${defaultEvery} (recommended)`
    return [{ title: label, value: defaultEvery }, ...ALL_SCHEDULE_OPTIONS]
  }
  return ALL_SCHEDULE_OPTIONS
})

function selectPreset(preset: WatcherPreset): void {
  activePreset.value = preset

  // Reset param values
  for (const key of Object.keys(paramValues)) {
    delete paramValues[key]
  }
  for (const p of preset.params) {
    paramValues[p.name] = ''
  }

  // Pre-fill name with the preset title; user may override it
  configName.value = preset.title

  // Default to the preset's recommended schedule
  configSchedule.value = preset.defaultScheduleEvery
  configCustomEvery.value = ''
  configJitter.value = ''
  configWindow.value = ''
  showAdvanced.value = false
  createError.value = null

  step.value = 'configure'
}

function paramLabel(param: WatcherPresetParam): string {
  const humanized = param.name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  return param.required ? `${humanized} *` : humanized
}

// ─── Form validation ─────────────────────────────────────────────────────────

function validateConfigure(): string | null {
  for (const p of activePreset.value?.params ?? []) {
    if (p.required && !paramValues[p.name]?.trim()) {
      const humanized = p.name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
      return `${humanized} is required`
    }
  }

  const every =
    configSchedule.value === 'custom' ? configCustomEvery.value.trim() : configSchedule.value
  if (!every) return 'Schedule is required'
  if (!/^\d+[mhd]$/.test(every)) return 'Invalid interval — use e.g. "30m", "4h", "1d"'

  const units: Record<string, number> = { m: 60, h: 3600, d: 86400 }
  const unit = every.slice(-1)
  const sec = parseInt(every.slice(0, -1), 10) * (units[unit] ?? 0)
  if (sec < 60) return 'Minimum interval is 60 seconds (1m)'

  if (configJitter.value.trim() && !/^\d+[mhd]$/.test(configJitter.value.trim())) {
    return 'Invalid jitter — use e.g. "5m", "1h"'
  }
  if (configWindow.value.trim() && !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(configWindow.value.trim())) {
    return 'Invalid window — use e.g. "06:00-22:00"'
  }

  return null
}

// ─── Submit ──────────────────────────────────────────────────────────────────

async function submitPreset(): Promise<void> {
  const validationErr = validateConfigure()
  if (validationErr) {
    createError.value = validationErr
    return
  }
  createError.value = null
  creating.value = true

  try {
    const every =
      configSchedule.value === 'custom' ? configCustomEvery.value.trim() : configSchedule.value

    const schedule: { every: string; jitter?: string; window?: string } = { every }
    if (configJitter.value.trim()) schedule.jitter = configJitter.value.trim()
    if (configWindow.value.trim()) schedule.window = configWindow.value.trim()

    // Only include params with a filled value — the server treats absent optional params as defaults
    const params: Record<string, string> = {}
    for (const [key, val] of Object.entries(paramValues)) {
      if (val.trim()) params[key] = val.trim()
    }

    await watchersStore.createWatcherFromPreset({
      preset_id: activePreset.value!.id,
      params,
      name: configName.value.trim() || undefined,
      schedule,
    })

    show.value = false
    emit('created')
  } catch (err) {
    if (err instanceof ApiClientError) {
      if (err.body.issues && err.body.issues.length > 0) {
        createError.value = err.body.issues.map((i) => i.message).join('; ')
      } else {
        createError.value = err.body.message ?? err.message
      }
    } else {
      createError.value = err instanceof Error ? err.message : 'Failed to create watcher'
    }
  } finally {
    creating.value = false
  }
}

// ─── Reset state when dialog fully closes ────────────────────────────────────

function onDialogClosed(): void {
  step.value = 'gallery'
  activePreset.value = null
  createError.value = null
  for (const key of Object.keys(paramValues)) {
    delete paramValues[key]
  }
}
</script>

<style scoped>
/* Gallery scroll area */
.gallery-scroll {
  max-height: 52vh;
  overflow-y: auto;
}

/* Category chip row — scroll horizontally on narrow screens */
.category-scroll {
  overflow-x: auto;
  scrollbar-width: none;
}
.category-scroll::-webkit-scrollbar {
  display: none;
}

/* Configure scroll */
.configure-scroll {
  max-height: 65vh;
  overflow-y: auto;
}

/* Preset cards are clickable — override the default non-interactive cursor */
.preset-card {
  cursor: pointer;
  user-select: none;
}

/* Keep the chevron softly invisible until hover */
.preset-chevron {
  opacity: 0.35;
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.preset-card:hover .preset-chevron,
.preset-card:focus .preset-chevron {
  opacity: 0.85;
  transform: translateX(2px);
}

/* Focused card gets the same glow as hovered card (app.css handles hover via border-color) */
.preset-card:focus {
  outline: none;
}

/* Small square icon container */
.preset-icon-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  flex-shrink: 0;
  margin-top: 1px;
}

/* Clamp description to 2 lines */
.preset-desc {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.45;
}

/* Prevent long preset title from overflowing */
.preset-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 180px;
}
</style>
