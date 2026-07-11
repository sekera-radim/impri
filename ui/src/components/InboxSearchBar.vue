<template>
  <div class="inbox-search-bar">
    <div class="d-flex flex-wrap gap-2 align-center">
      <!-- Text search -->
      <v-text-field
        ref="searchInputRef"
        v-model="localQ"
        placeholder="Search…"
        prepend-inner-icon="mdi-magnify"
        variant="outlined"
        density="compact"
        clearable
        hide-details
        class="search-field"
        aria-label="Search actions"
        @update:model-value="onQInput"
        @keydown.esc="blur"
      />

      <!-- Kind filter -->
      <v-combobox
        v-model="localKind"
        :items="kindItems"
        label="Kind"
        variant="outlined"
        density="compact"
        clearable
        hide-details
        class="kind-field"
        @update:model-value="onKindChange"
      />

      <!-- Since / time-range -->
      <v-select
        v-model="localSince"
        :items="sinceOptions"
        item-title="title"
        item-value="value"
        label="Time range"
        variant="outlined"
        density="compact"
        hide-details
        class="since-field"
        @update:model-value="onSinceChange"
      />

      <!-- Active filter chip -->
      <v-chip
        v-if="hasActiveFilters"
        closable
        color="primary"
        size="small"
        variant="tonal"
        @click:close="$emit('clear-filters')"
      >
        Filtered
      </v-chip>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import type { SinceOption } from '../stores/inbox'

const props = defineProps<{
  q: string
  kind: string
  since: SinceOption
  kindItems: string[]
  hasActiveFilters: boolean
}>()

const emit = defineEmits<{
  'update:q': [value: string]
  'update:kind': [value: string]
  'update:since': [value: SinceOption]
  'clear-filters': []
  'search-focus': []
}>()

const searchInputRef = ref<{ focus: () => void; $el: HTMLElement } | null>(null)

// Local reactive copies to avoid mutating props directly
const localQ = ref(props.q)
const localKind = ref(props.kind)
const localSince = ref<SinceOption>(props.since)

// Sync props → local when parent changes them (e.g. clear-filters)
watch(() => props.q, (v) => { localQ.value = v })
watch(() => props.kind, (v) => { localKind.value = v })
watch(() => props.since, (v) => { localSince.value = v })

const sinceOptions: { title: string; value: SinceOption }[] = [
  { title: 'All time', value: 'all' },
  { title: 'Last 24 h', value: 'h24' },
  { title: 'Last 7 days', value: 'd7' },
  { title: 'Last 30 days', value: 'd30' },
]

// Debounce for text search
let debounceTimer: ReturnType<typeof setTimeout> | null = null

function onQInput(val: string | null): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    emit('update:q', val ?? '')
  }, 300)
}

function onKindChange(val: string | null): void {
  emit('update:kind', val ?? '')
}

function onSinceChange(val: SinceOption | null): void {
  emit('update:since', val ?? 'all')
}

function blur(): void {
  // Let the parent handle Escape so it can clear bulk mode etc.
  // Just blur the input here so keydown falls through to InboxList handler.
  const input = searchInputRef.value?.$el?.querySelector('input')
  input?.blur()
}

/** Called by parent (InboxList) when / key is pressed */
function focusSearch(): void {
  const input = searchInputRef.value?.$el?.querySelector('input') as HTMLInputElement | null
  if (input) {
    input.focus()
    input.select()
  }
}

defineExpose({ focusSearch })
</script>

<style scoped>
.inbox-search-bar {
  width: 100%;
}

.search-field {
  flex: 1 1 180px;
  min-width: 140px;
}

.kind-field {
  flex: 0 1 140px;
  min-width: 100px;
}

.since-field {
  flex: 0 1 140px;
  min-width: 110px;
}

.gap-2 { gap: 8px; }
</style>
