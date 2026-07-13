import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useAuthStore } from './auth'
import type { Action, ActionStatus, BulkDecisionResponse } from '../types'
import { ApiClientError } from '../api/client'

const POLL_INTERVAL_MS = 5_000

export type SinceOption = 'all' | 'h24' | 'd7' | 'd30'

export const useInboxStore = defineStore('inbox', () => {
  const auth = useAuthStore()

  const actions = ref<Action[]>([])
  const statusFilter = ref<ActionStatus>('pending')
  const searchQuery = ref('')
  const kindFilter = ref('')
  const sinceFilter = ref<SinceOption>('all')
  const loading = ref(false)
  // Any fetch in flight, including silent background polls — drives the small refresh
  // icon spinner, independent of `loading` (which drives the full skeleton).
  const refreshing = ref(false)
  const error = ref<string | null>(null)
  const lastFetchedAt = ref<number | null>(null)
  const hasMore = ref(false)
  const nextCursor = ref<string | undefined>(undefined)

  // Distinct kinds seen across fetches — used to populate kind filter dropdown
  const seenKinds = ref<string[]>([])

  let pollTimer: ReturnType<typeof setInterval> | null = null

  const pendingCount = computed(() =>
    actions.value.filter((a) => a.status === 'pending').length,
  )

  // Tracks the real pending total regardless of which filter is active.
  const pendingTotal = ref(0)

  /** Whether any non-default filter is active */
  const hasActiveFilters = computed(() =>
    statusFilter.value !== 'pending' ||
    searchQuery.value !== '' ||
    kindFilter.value !== '' ||
    sinceFilter.value !== 'all',
  )

  function sinceTimestamp(): number | undefined {
    const now = Math.floor(Date.now() / 1000)
    switch (sinceFilter.value) {
      case 'h24': return now - 86400
      case 'd7': return now - 604800
      case 'd30': return now - 2592000
      default: return undefined
    }
  }

  async function fetchActions(silent = false): Promise<void> {
    const client = auth.client
    if (!client) return
    try {
      // Every fetch spins the small refresh icon (refreshing). Background polls
      // (silent=true) skip `loading` so an empty/steady inbox doesn't flash the full
      // skeleton every few seconds. Data still updates either way.
      refreshing.value = true
      if (!silent) loading.value = true
      error.value = null
      const res = await client.listActions({
        status: statusFilter.value,
        limit: 50,
        q: searchQuery.value || undefined,
        kind: kindFilter.value || undefined,
        since: sinceTimestamp(),
      })
      actions.value = res.items
      hasMore.value = res.has_more
      nextCursor.value = res.next_cursor
      lastFetchedAt.value = Date.now()
      // Track seen kinds
      const newKinds = res.items.map((a) => a.kind).filter(Boolean)
      seenKinds.value = [...new Set([...seenKinds.value, ...newKinds])]
      // When viewing the pending filter the result IS the pending total
      if (statusFilter.value === 'pending') {
        pendingTotal.value = res.items.length + (res.has_more ? 1 : 0)
      }
    } catch (err) {
      if (err instanceof ApiClientError && (err.status === 401 || err.status === 403)) {
        auth.logout()
      } else {
        error.value = err instanceof Error ? err.message : 'Unknown error loading inbox'
      }
    } finally {
      refreshing.value = false
      if (!silent) loading.value = false
    }
  }

  async function loadMore(): Promise<void> {
    const client = auth.client
    if (!client || !hasMore.value || !nextCursor.value) return
    // Reset poll timer to avoid race with background refresh
    resetPollTimer()
    try {
      loading.value = true
      const res = await client.listActions({
        status: statusFilter.value,
        limit: 50,
        q: searchQuery.value || undefined,
        kind: kindFilter.value || undefined,
        since: sinceTimestamp(),
        cursor: nextCursor.value,
      })
      actions.value = [...actions.value, ...res.items]
      hasMore.value = res.has_more
      nextCursor.value = res.next_cursor
      lastFetchedAt.value = Date.now()
      const newKinds = res.items.map((a) => a.kind).filter(Boolean)
      seenKinds.value = [...new Set([...seenKinds.value, ...newKinds])]
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Error loading more'
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
    actions.value = []
    statusFilter.value = status
    void fetchActions()
    if (status !== 'pending') {
      void refreshPendingTotal()
    }
  }

  function setSearchQuery(q: string): void {
    searchQuery.value = q
    actions.value = []
    void fetchActions()
  }

  function setKindFilter(kind: string): void {
    kindFilter.value = kind
    actions.value = []
    void fetchActions()
  }

  function setSinceFilter(since: SinceOption): void {
    sinceFilter.value = since
    actions.value = []
    void fetchActions()
  }

  function clearFilters(): void {
    statusFilter.value = 'pending'
    searchQuery.value = ''
    kindFilter.value = ''
    sinceFilter.value = 'all'
    actions.value = []
    void fetchActions()
  }

  function resetPollTimer(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer)
    }
    pollTimer = setInterval(() => {
      void fetchActions(true)
      if (statusFilter.value !== 'pending') {
        void refreshPendingTotal()
      }
    }, POLL_INTERVAL_MS)
  }

  function startPolling(): void {
    void fetchActions()
    void refreshPendingTotal()
    pollTimer = setInterval(() => {
      void fetchActions(true)
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
      if (updated.status !== statusFilter.value) {
        actions.value.splice(idx, 1)
      } else {
        actions.value[idx] = updated
      }
    }
  }

  /** Re-insert an action at a given index (used for optimistic update rollback). */
  function insertAction(action: Action, atIdx: number): void {
    const clamped = Math.max(0, Math.min(atIdx, actions.value.length))
    actions.value.splice(clamped, 0, action)
  }

  async function bulkDecide(
    ids: string[],
    verdict: 'approve' | 'reject',
    comment?: string,
  ): Promise<BulkDecisionResponse> {
    const client = auth.client
    if (!client) throw new Error('Not authenticated')

    // Save originals + indices before optimistic removal
    const originals = ids.map((id) => ({
      id,
      action: actions.value.find((a) => a.id === id),
      idx: actions.value.findIndex((a) => a.id === id),
    }))

    // Optimistic update: mark each selected item with the new status
    const optimisticStatus: ActionStatus = verdict === 'approve' ? 'approved' : 'rejected'
    for (const { action } of originals) {
      if (action) {
        updateAction({ ...action, status: optimisticStatus })
      }
    }

    try {
      const res = await client.bulkDecide({ ids, verdict, comment })

      // Restore items that failed (per-item errors)
      for (const result of res.results) {
        if (!result.ok) {
          const orig = originals.find((o) => o.id === result.id)
          if (orig?.action) {
            // Re-insert at approximate original position
            insertAction(orig.action, Math.min(orig.idx, actions.value.length))
          }
        }
      }

      // Refresh pending count after bulk operation
      if (statusFilter.value === 'pending') {
        pendingTotal.value = actions.value.filter((a) => a.status === 'pending').length
      }

      return res
    } catch (err) {
      // Network / server error: restore all and refetch
      await fetchActions()
      throw err
    }
  }

  return {
    actions,
    statusFilter,
    searchQuery,
    kindFilter,
    sinceFilter,
    loading,
    refreshing,
    error,
    lastFetchedAt,
    pendingCount,
    pendingTotal,
    hasMore,
    nextCursor,
    seenKinds,
    hasActiveFilters,
    fetchActions,
    loadMore,
    fetchPendingCount,
    setFilter,
    setSearchQuery,
    setKindFilter,
    setSinceFilter,
    clearFilters,
    startPolling,
    stopPolling,
    updateAction,
    insertAction,
    bulkDecide,
  }
})
