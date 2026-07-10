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

  async function fetchActions(): Promise<void> {
    const client = auth.client
    if (!client) return
    try {
      loading.value = true
      error.value = null
      const res = await client.listActions({ status: statusFilter.value, limit: 50 })
      actions.value = res.items
      lastFetchedAt.value = Date.now()
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
      const res = await client.listActions({ status: 'pending', limit: 1 })
      // We only care about count; items gives us rough idea for badge
      return res.items.length + (res.has_more ? 1 : 0)
    } catch {
      return 0
    }
  }

  function setFilter(status: ActionStatus): void {
    statusFilter.value = status
    void fetchActions()
  }

  function startPolling(): void {
    void fetchActions()
    pollTimer = setInterval(() => {
      void fetchActions()
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
    fetchActions,
    fetchPendingCount,
    setFilter,
    startPolling,
    stopPolling,
    updateAction,
  }
})
