<template>
  <div>
    <!-- Toolbar row 1: status tabs + refresh -->
    <div class="d-flex align-center mb-2 flex-wrap gap-2">
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

      <!-- Bulk: select-all checkbox when in bulk mode -->
      <v-checkbox
        v-if="isBulkMode"
        :model-value="allVisibleSelected"
        :indeterminate="someVisibleSelected && !allVisibleSelected"
        density="compact"
        hide-details
        label="Select all"
        class="select-all-checkbox"
        @update:model-value="toggleSelectAll"
      />

      <!-- Shortcut help button -->
      <v-btn
        icon="mdi-keyboard"
        variant="text"
        size="small"
        title="Keyboard shortcuts (?)"
        aria-label="Keyboard shortcuts"
        @click="showShortcuts = true"
      />

      <span v-if="inbox.lastFetchedAt" class="text-caption text-medium-emphasis">
        Updated {{ lastFetchedLabel }}
      </span>

      <v-btn
        icon="mdi-refresh"
        variant="text"
        size="small"
        title="Refresh"
        aria-label="Refresh"
        :loading="inbox.loading && inbox.actions.length > 0"
        @click="inbox.fetchActions()"
      />
    </div>

    <!-- Toolbar row 2: search bar -->
    <div class="mb-3">
      <InboxSearchBar
        ref="searchBarRef"
        :q="inbox.searchQuery"
        :kind="inbox.kindFilter"
        :since="inbox.sinceFilter"
        :kind-items="inbox.seenKinds"
        :has-active-filters="inbox.hasActiveFilters"
        @update:q="inbox.setSearchQuery"
        @update:kind="inbox.setKindFilter"
        @update:since="inbox.setSinceFilter"
        @clear-filters="inbox.clearFilters()"
      />
    </div>

    <!-- Background polls refresh silently (no skeleton/spinner) so a steady or empty
         inbox doesn't flash every few seconds — freshness shows via the "Updated"
         timestamp above. A manual refresh (button) still shows the spinner. No inline
         progress bar here either, because inserting it above the list shifts every
         row down and makes the page visibly jump. -->

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

    <!-- Loading skeleton on very first load (no actions yet) -->
    <template v-if="inbox.loading && inbox.actions.length === 0">
      <v-skeleton-loader
        v-for="i in 3"
        :key="i"
        type="list-item-two-line"
        class="mb-2"
      />
    </template>

    <!-- Empty state: no actions + active filters -->
    <v-card
      v-else-if="!inbox.loading && inbox.actions.length === 0 && inbox.hasActiveFilters"
      variant="outlined"
      class="text-center py-10"
    >
      <v-icon size="40" color="grey-lighten-1" class="mb-2">mdi-filter-off-outline</v-icon>
      <div class="text-body-1 text-medium-emphasis mb-3">
        No actions match your filters.
      </div>
      <v-btn variant="tonal" size="small" @click="inbox.clearFilters()">Clear filters</v-btn>
    </v-card>

    <!-- Empty state: no actions + no filters (default) -->
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
        v-for="(action, index) in inbox.actions"
        :key="action.id"
        :action="action"
        :focused="focusedIdx === index"
        :selected="isSelected(action.id)"
        :bulk-mode="isBulkMode"
        :highlight="inbox.searchQuery"
        :kbd-idx="index"
        @click="openDetail(action)"
        @toggle-select="toggleSelectAction"
      />

      <!-- Load more button -->
      <div v-if="inbox.hasMore" class="text-center mt-3 mb-2">
        <v-btn
          variant="tonal"
          size="small"
          :loading="inbox.loading"
          @click="inbox.loadMore()"
        >
          Load more
        </v-btn>
      </div>
    </template>

    <!-- Bulk action bar -->
    <BulkActionBar
      v-if="isBulkMode"
      :selected-count="selectedCount"
      :verdict-loading="bulkLoading"
      @bulk-approve="askBulkConfirm('approve')"
      @bulk-reject="askBulkConfirm('reject')"
      @deselect-all="deselectAll"
    />
  </div>

  <!-- Detail dialog -->
  <ActionDetail
    v-model="showDetail"
    :action="selectedAction"
    :open-in-edit-mode="openInEditMode"
    :auto-verdict="detailAutoVerdict"
    @decided="handleDecided"
  />

  <!-- Shortcut help dialog -->
  <ShortcutHelpDialog v-model="showShortcuts" />

  <!-- Bulk confirm dialog -->
  <v-dialog v-model="showBulkConfirm" max-width="420">
    <v-card>
      <v-card-title class="text-h6">
        {{ pendingBulkVerdict === 'approve' ? 'Approve' : 'Reject' }} {{ bulkConfirmCount }} action{{ bulkConfirmCount !== 1 ? 's' : '' }}?
      </v-card-title>
      <v-card-text>
        <template v-if="pendingBulkVerdict === 'approve'">
          {{ bulkConfirmCount }} pending action{{ bulkConfirmCount !== 1 ? 's' : '' }} will be approved as-is. Editable drafts are approved without edits — open one individually to tweak it first.
        </template>
        <template v-else>
          {{ bulkConfirmCount }} pending action{{ bulkConfirmCount !== 1 ? 's' : '' }} will be rejected. This can't be undone.
        </template>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" :disabled="bulkLoading !== null" @click="showBulkConfirm = false">Cancel</v-btn>
        <v-btn
          :color="pendingBulkVerdict === 'approve' ? 'success' : 'error'"
          variant="flat"
          :loading="bulkLoading !== null"
          @click="confirmBulk"
        >
          {{ pendingBulkVerdict === 'approve' ? 'Approve' : 'Reject' }} {{ bulkConfirmCount }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <!-- Bulk result snackbar -->
  <v-snackbar
    v-model="showBulkResult"
    :timeout="3000"
    :color="bulkResultColor"
    location="bottom"
  >
    {{ bulkResultMessage }}
  </v-snackbar>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useInboxStore } from '../stores/inbox'
import { useKeyboardNav, isFormFieldFocused } from '../composables/useKeyboardNav'
import type { Action, ActionStatus } from '../types'
import ActionCard from './ActionCard.vue'
import ActionDetail from './ActionDetail.vue'
import InboxSearchBar from './InboxSearchBar.vue'
import BulkActionBar from './BulkActionBar.vue'
import ShortcutHelpDialog from './ShortcutHelpDialog.vue'

const inbox = useInboxStore()

// ── Status filter ─────────────────────────────────────────────────────────────

const selectedStatus = ref<ActionStatus>('pending')

const statusOptions: { value: ActionStatus; label: string }[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'expired', label: 'Expired' },
  { value: 'executed', label: 'Executed' },
  { value: 'execute_failed', label: 'Failed' },
]

const pendingTotal = computed(() => inbox.pendingTotal)

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

// ── Detail dialog ─────────────────────────────────────────────────────────────

const showDetail = ref(false)
const selectedAction = ref<Action | null>(null)
const openInEditMode = ref(false)
const detailAutoVerdict = ref<'approve' | 'reject' | undefined>(undefined)

function openDetail(action: Action, editMode = false, autoVerdict?: 'approve' | 'reject'): void {
  selectedAction.value = action
  openInEditMode.value = editMode
  detailAutoVerdict.value = autoVerdict
  showDetail.value = true
}

function handleDecided(): void {
  inbox.fetchActions()
}

// ── Keyboard navigation composable ────────────────────────────────────────────

const {
  focusedIdx,
  selectedIds,
  isBulkMode,
  selectedCount,
  focusNext,
  focusPrev,
  toggleSelect,
  selectAll,
  deselectAll,
  isSelected,
} = useKeyboardNav()

// ── Bulk selection helpers ────────────────────────────────────────────────────

/** Action IDs eligible for bulk. Editable actions are included too — bulk-approve
 * uses the stored draft as-is (same as approving one without editing); to tweak the
 * wording first, open the action and approve it there. Backend /bulk-decision already
 * decides on the original preview regardless of editable fields. */
const bulkEligibleIds = computed(() =>
  inbox.actions.map((a) => a.id),
)

const allVisibleSelected = computed(
  () => bulkEligibleIds.value.length > 0 &&
    bulkEligibleIds.value.every((id) => isSelected(id)),
)

const someVisibleSelected = computed(
  () => bulkEligibleIds.value.some((id) => isSelected(id)),
)

function toggleSelectAll(value: boolean | null): void {
  if (value) {
    selectAll(bulkEligibleIds.value)
  } else {
    deselectAll()
  }
}

function toggleSelectAction(id: string): void {
  toggleSelect(id)
}

// ── Bulk decision ─────────────────────────────────────────────────────────────

const bulkLoading = ref<'approve' | 'reject' | null>(null)
const showBulkResult = ref(false)
const bulkResultMessage = ref('')
const bulkResultColor = ref<'success' | 'error'>('success')

async function executeBulk(verdict: 'approve' | 'reject'): Promise<void> {
  const ids = [...selectedIds.value]
  if (ids.length === 0) return

  bulkLoading.value = verdict
  try {
    const res = await inbox.bulkDecide(ids, verdict)
    deselectAll()

    if (res.failed === 0) {
      bulkResultMessage.value = `${res.succeeded} action${res.succeeded !== 1 ? 's' : ''} ${verdict}d successfully.`
      bulkResultColor.value = 'success'
    } else {
      bulkResultMessage.value = `${res.succeeded} succeeded, ${res.failed} failed (already decided or not found).`
      bulkResultColor.value = res.succeeded > 0 ? 'success' : 'error'
    }
    showBulkResult.value = true
  } catch {
    bulkResultMessage.value = 'Bulk action failed. Please try again.'
    bulkResultColor.value = 'error'
    showBulkResult.value = true
  } finally {
    bulkLoading.value = null
  }
}

// Confirm step before a bulk decision — bulk approve/reject touches many actions at
// once, so require an explicit confirm. Count is snapshotted when the dialog opens.
const showBulkConfirm = ref(false)
const pendingBulkVerdict = ref<'approve' | 'reject' | null>(null)
const bulkConfirmCount = ref(0)

function askBulkConfirm(verdict: 'approve' | 'reject'): void {
  if (selectedIds.value.size === 0) return
  pendingBulkVerdict.value = verdict
  bulkConfirmCount.value = selectedIds.value.size
  showBulkConfirm.value = true
}

async function confirmBulk(): Promise<void> {
  const verdict = pendingBulkVerdict.value
  if (!verdict) return
  await executeBulk(verdict)
  showBulkConfirm.value = false
  pendingBulkVerdict.value = null
}

// ── Shortcut help ─────────────────────────────────────────────────────────────

const showShortcuts = ref(false)

// ── Search bar ref ────────────────────────────────────────────────────────────

const searchBarRef = ref<{ focusSearch: () => void } | null>(null)

// ── Keyboard event handler ────────────────────────────────────────────────────

function onKeydown(e: KeyboardEvent): void {
  // Never intercept when a modifier other than Shift is held
  if (e.ctrlKey || e.altKey || e.metaKey) return

  const listLen = inbox.actions.length

  switch (e.key) {
    case 'j':
      if (!isFormFieldFocused()) {
        e.preventDefault()
        focusNext(listLen)
        scrollFocusedCard()
      }
      break

    case 'k':
      if (!isFormFieldFocused()) {
        e.preventDefault()
        focusPrev(listLen)
        scrollFocusedCard()
      }
      break

    case 'Enter':
    case ' ':
      if (!isFormFieldFocused() && focusedIdx.value >= 0 && !showDetail.value) {
        e.preventDefault()
        const action = inbox.actions[focusedIdx.value]
        if (action) openDetail(action)
      }
      break

    case 'a':
      if (!isFormFieldFocused() && focusedIdx.value >= 0 && !showDetail.value) {
        e.preventDefault()
        const action = inbox.actions[focusedIdx.value]
        if (action && action.status === 'pending') {
          // Editable fields → open detail in edit mode so user can review / edit first
          // No editable fields → skip directly to the confirm step in DecisionDialog
          openDetail(action, action.editable.length > 0, action.editable.length === 0 ? 'approve' : undefined)
        }
      }
      break

    case 'r':
      if (!isFormFieldFocused() && focusedIdx.value >= 0 && !showDetail.value) {
        e.preventDefault()
        const action = inbox.actions[focusedIdx.value]
        if (action && action.status === 'pending') {
          // Reject goes directly to confirm step
          openDetail(action, false, 'reject')
        }
      }
      break

    case 'e':
      if (!isFormFieldFocused() && focusedIdx.value >= 0 && !showDetail.value) {
        e.preventDefault()
        const action = inbox.actions[focusedIdx.value]
        if (action) openDetail(action, true)
      }
      break

    case 'x':
      if (!isFormFieldFocused() && focusedIdx.value >= 0) {
        e.preventDefault()
        const action = inbox.actions[focusedIdx.value]
        if (action && action.editable.length === 0) {
          toggleSelect(action.id)
        }
      }
      break

    case '/':
      // Focus search, prevent browser find-in-page
      e.preventDefault()
      searchBarRef.value?.focusSearch()
      break

    case 'A':
      // Shift+A → bulk approve (goes through the same confirm dialog as the button)
      if (e.shiftKey && !isFormFieldFocused() && isBulkMode.value) {
        e.preventDefault()
        askBulkConfirm('approve')
      }
      break

    case 'R':
      // Shift+R → bulk reject (goes through the same confirm dialog as the button)
      if (e.shiftKey && !isFormFieldFocused() && isBulkMode.value) {
        e.preventDefault()
        askBulkConfirm('reject')
      }
      break

    case 'Escape':
      if (showDetail.value) {
        showDetail.value = false
      } else if (showShortcuts.value) {
        showShortcuts.value = false
      } else if (isFormFieldFocused()) {
        ;(document.activeElement as HTMLElement)?.blur()
      } else if (isBulkMode.value) {
        deselectAll()
      }
      break

    case '?':
      if (!isFormFieldFocused()) {
        e.preventDefault()
        showShortcuts.value = true
      }
      break
  }
}

function scrollFocusedCard(): void {
  // Let Vue update the DOM first
  setTimeout(() => {
    const el = document.querySelector(`[data-kbd-idx="${focusedIdx.value}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, 0)
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

onMounted(() => {
  inbox.startPolling()
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  inbox.stopPolling()
  window.removeEventListener('keydown', onKeydown)
})
</script>

<style scoped>
.gap-2 { gap: 8px; }

.filter-scroll {
  overflow-x: auto;
  max-width: 100%;
}

.select-all-checkbox {
  flex-shrink: 0;
}
</style>
