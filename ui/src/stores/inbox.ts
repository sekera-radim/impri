import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useAuthStore } from './auth'
import type { Action, ActionStatus } from '../types'
import { ApiClientError } from '../api/client'

const POLL_INTERVAL_MS = 5_000

export const useInboxStore = defineStore('inbox', () => {
  const auth = useAuthStore()

  const actions = ref<Action[]>([])
  const statusFilter = ref<ActionStatus>('pending')
  const loading = ref(false)
  const error = ref<string | null>(null)
  const lastFetchedAt = ref<number | null>(null)

  let pollTimer: ReturnType<typeof setInterval> | null = null

  const pendingCount = computed(() =>
    actions.value.filter((a) => a.status === 'pending').length,
  )

  // Tracks the real pending total regardless of which filter is active.
  // Used for the badge in the nav bar and filter toolbar.
  const pendingTotal = ref(0)

  async function fetchActions(): Promise<void> {
    const client = auth.client
    if (!client) return
    try {
      loading.value = true
      error.value = null
      const res = await client.listActions({ status: statusFilter.value, limit: 50 })
      actions.value = res.items
      lastFetchedAt.value = Date.now()
      // When viewing the pending filter the result IS the pending total
      if (statusFilter.value === 'pending') {
        pendingTotal.value = res.items.length
      }
    } catch (err) {
      if (err instanceof ApiClientError && (err.status === 401 || err.status === 403)) {
        auth.logout()
      } else {
        error.value = err instanceof Error ? err.message : 'Unknown error loading inbox'
      }
    } finally {
      loading.value = false
    }
  }

  async function fetchPendingCount(): Promise<number> {
    const client = auth.client
    if (!client) return 0
    try {
      const res = await client.listActions({ status: 'pending', limit: 50 })
      return res.items.length + (res.has_more ? 1 : 0)
    } catch {
      return 0
    }
  }

  async function refreshPendingTotal(): Promise<void> {
    const n = await fetchPendingCount()
    pendingTotal.value = n
  }

  function setFilter(status: ActionStatus): void {
    // Clear old items immediately so the skeleton shows instead of stale data
    actions.value = []
    statusFilter.value = status
    void fetchActions()
    // Keep badge accurate when switching to a non-pending filter
    if (status !== 'pending') {
      void refreshPendingTotal()
    }
  }

  function startPolling(): void {
    void fetchActions()
    // Seed the badge immediately in case we start on a non-pending filter
    void refreshPendingTotal()
    pollTimer = setInterval(() => {
      void fetchActions()
      // Fetch pending total separately when not viewing the pending filter
      if (statusFilter.value !== 'pending') {
        void refreshPendingTotal()
      }
    }, POLL_INTERVAL_MS)
  }

  function stopPolling(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  function updateAction(updated: Action): void {
    const idx = actions.value.findIndex((a) => a.id === updated.id)
    if (idx !== -1) {
      // Remove from list if it no longer matches current filter
      if (updated.status !== statusFilter.value) {
        actions.value.splice(idx, 1)
      } else {
        actions.value[idx] = updated
      }
    }
  }

  return {
    actions,
    statusFilter,
    loading,
    error,
    lastFetchedAt,
    pendingCount,
    pendingTotal,
    fetchActions,
    fetchPendingCount,
    setFilter,
    startPolling,
    stopPolling,
    updateAction,
  }
})
