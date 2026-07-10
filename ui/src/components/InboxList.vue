<template>
  <div>
    <!-- Toolbar: status filter tabs + refresh badge -->
    <div class="d-flex align-center mb-4 flex-wrap gap-2">
      <div class="filter-scroll">
        <v-btn-toggle
          v-model="selectedStatus"
          mandatory
          density="compact"
          variant="outlined"
          color="primary"
          divided
          @update:model-value="onFilterChange"
        >
          <v-btn
            v-for="s in statusOptions"
            :key="s.value"
            :value="s.value"
            size="small"
          >
            {{ s.label }}
            <v-badge
              v-if="s.value === 'pending' && pendingTotal > 0"
              :content="pendingTotal"
              color="error"
              inline
              class="ml-1"
            />
          </v-btn>
        </v-btn-toggle>
      </div>

      <v-spacer />

      <span v-if="inbox.lastFetchedAt" class="text-caption text-medium-emphasis">
        Updated {{ lastFetchedLabel }}
      </span>

      <v-btn
        icon="mdi-refresh"
        variant="text"
        size="small"
        title="Refresh"
        aria-label="Refresh"
        :loading="inbox.loading"
        @click="inbox.fetchActions()"
      />
    </div>

    <!-- Error state -->
    <v-alert
      v-if="inbox.error"
      type="error"
      variant="tonal"
      density="compact"
      class="mb-4"
      closable
      @click:close="inbox.error = null"
    >
      {{ inbox.error }}
    </v-alert>

    <!-- Loading skeleton on first load -->
    <template v-if="inbox.loading && inbox.actions.length === 0">
      <v-skeleton-loader
        v-for="i in 3"
        :key="i"
        type="list-item-two-line"
        class="mb-2"
      />
    </template>

    <!-- Empty state -->
    <v-card
      v-else-if="!inbox.loading && inbox.actions.length === 0"
      variant="outlined"
      class="text-center py-12"
    >
      <v-icon size="48" color="grey-lighten-1" class="mb-3">mdi-inbox-outline</v-icon>
      <div class="text-body-1 text-medium-emphasis">
        <template v-if="selectedStatus === 'pending'">
          Nothing to review right now — your watchers and agents will surface items here.
        </template>
        <template v-else>
          No {{ emptyStateLabel }} actions yet.
        </template>
      </div>
    </v-card>

    <!-- Action list -->
    <template v-else>
      <ActionCard
        v-for="action in inbox.actions"
        :key="action.id"
        :action="action"
        @click="openDetail(action)"
      />
    </template>
  </div>

  <!-- Detail dialog -->
  <ActionDetail
    v-model="showDetail"
    :action="selectedAction"
    @decided="inbox.fetchActions()"
  />
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useInboxStore } from '../stores/inbox'
import type { Action, ActionStatus } from '../types'
import ActionCard from './ActionCard.vue'
import ActionDetail from './ActionDetail.vue'

const inbox = useInboxStore()
const selectedStatus = ref<ActionStatus>('pending')
const showDetail = ref(false)
const selectedAction = ref<Action | null>(null)

const statusOptions: { value: ActionStatus; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'expired', label: 'Expired' },
  { value: 'executed', label: 'Executed' },
  { value: 'execute_failed', label: 'Failed' },
]

const pendingTotal = computed(() => inbox.pendingTotal)

// Human-readable label for the current filter used in the empty-state message
const emptyStateLabel = computed(() => {
  const opt = statusOptions.find((o) => o.value === selectedStatus.value)
  return opt ? opt.label.toLowerCase() : selectedStatus.value
})

const lastFetchedLabel = computed(() => {
  if (!inbox.lastFetchedAt) return ''
  const diffSec = Math.floor((Date.now() - inbox.lastFetchedAt) / 1000)
  if (diffSec < 5) return 'just now'
  if (diffSec < 60) return `${diffSec}s ago`
  return `${Math.floor(diffSec / 60)}m ago`
})

function onFilterChange(status: ActionStatus): void {
  inbox.setFilter(status)
}

function openDetail(action: Action): void {
  selectedAction.value = action
  showDetail.value = true
}

onMounted(() => {
  inbox.startPolling()
})

onUnmounted(() => {
  inbox.stopPolling()
})
</script>

<style scoped>
.gap-2 { gap: 8px; }

/* Prevent filter button-group from overflowing on narrow viewports */
.filter-scroll {
  overflow-x: auto;
  max-width: 100%;
}
</style>
