<template>
  <div class="bulk-bar" :class="{ 'bulk-bar--mobile': isMobile }">
    <div class="bulk-bar__inner">
      <div class="bulk-bar__info">
        <v-icon size="18" class="mr-1">mdi-checkbox-multiple-marked-outline</v-icon>
        <span class="text-body-2 font-weight-medium">{{ selectedCount }} selected</span>
      </div>

      <div class="bulk-bar__actions" :class="{ 'bulk-bar__actions--stacked': isMobile }">
        <v-btn
          color="success"
          variant="flat"
          size="small"
          prepend-icon="mdi-check-all"
          :loading="verdictLoading === 'approve'"
          :disabled="verdictLoading !== null"
          @click="$emit('bulk-approve')"
        >
          Approve {{ selectedCount }}
        </v-btn>
        <v-btn
          color="error"
          variant="tonal"
          size="small"
          prepend-icon="mdi-close-box-multiple-outline"
          :loading="verdictLoading === 'reject'"
          :disabled="verdictLoading !== null"
          @click="$emit('bulk-reject')"
        >
          Reject {{ selectedCount }}
        </v-btn>
        <v-btn
          variant="text"
          size="small"
          icon="mdi-close"
          title="Deselect all (Esc)"
          aria-label="Deselect all"
          :disabled="verdictLoading !== null"
          @click="$emit('deselect-all')"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useDisplay } from 'vuetify'

defineProps<{
  selectedCount: number
  verdictLoading: 'approve' | 'reject' | null
}>()

defineEmits<{
  'bulk-approve': []
  'bulk-reject': []
  'deselect-all': []
}>()

const { mobile } = useDisplay()
const isMobile = computed(() => mobile.value)
</script>

<style scoped>
.bulk-bar {
  position: sticky;
  bottom: 16px;
  z-index: 10;
  margin-top: 8px;
}

.bulk-bar--mobile {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  margin: 0;
  border-radius: 0;
}

.bulk-bar__inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgba(var(--v-theme-primary), 0.4);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  gap: 12px;
}

.bulk-bar--mobile .bulk-bar__inner {
  border-radius: 0;
  border-left: none;
  border-right: none;
  border-bottom: none;
}

.bulk-bar__info {
  display: flex;
  align-items: center;
  white-space: nowrap;
}

.bulk-bar__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.bulk-bar__actions--stacked {
  flex: 1;
  justify-content: flex-end;
}
</style>
