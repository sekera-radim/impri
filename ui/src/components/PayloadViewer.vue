<template>
  <div>
    <v-btn
      variant="text"
      size="x-small"
      density="compact"
      :prepend-icon="expanded ? 'mdi-chevron-up' : 'mdi-chevron-down'"
      class="mb-1 px-0"
      @click="expanded = !expanded"
    >
      {{ expanded ? 'Hide' : 'Show' }} payload JSON
    </v-btn>

    <v-expand-transition>
      <pre v-if="expanded" class="payload-json">{{ formatted }}</pre>
    </v-expand-transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'

const props = defineProps<{
  payload: unknown
}>()

const expanded = ref(false)

const formatted = computed(() => JSON.stringify(props.payload, null, 2))
</script>

<style scoped>
.payload-json {
  font-family: 'Roboto Mono', monospace;
  font-size: 0.78rem;
  white-space: pre-wrap;
  word-break: break-all;
  background: rgba(0, 0, 0, 0.04);
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 4px;
  padding: 0.75rem;
  max-height: 300px;
  overflow-y: auto;
}
</style>
