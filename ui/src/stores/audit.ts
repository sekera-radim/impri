import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useAuthStore } from './auth'
import { ApiClientError } from '../api/client'
import type { AuditEvent } from '../types'

export interface AuditQueryParams {
  type?: string
  actor?: string
  entity_id?: string
  since?: number
  until?: number
}

export const useAuditStore = defineStore('audit', () => {
  const auth = useAuthStore()

  const events = ref<AuditEvent[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const hasMore = ref(false)
  const nextCursor = ref<string | undefined>(undefined)
  const exporting = ref(false)

  // Retained so loadMore can append with the same filter set.
  let lastParams: AuditQueryParams = {}

  async function fetchAudit(params: AuditQueryParams = {}): Promise<void> {
    const client = auth.client
    if (!client) return
    lastParams = params
    try {
      loading.value = true
      error.value = null
      events.value = []
      const res = await client.listAudit({ ...params, limit: 50 })
      events.value = res.items
      hasMore.value = res.has_more
      nextCursor.value = res.next_cursor
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.status === 401) {
          auth.logout()
        } else if (err.status === 403) {
          error.value = 'Audit log requires an admin-scope API key.'
        } else {
          error.value = err.body.message ?? err.message
        }
      } else {
        error.value = err instanceof Error ? err.message : 'Unknown error loading audit log'
      }
    } finally {
      loading.value = false
    }
  }

  async function loadMore(): Promise<void> {
    const client = auth.client
    if (!client || !hasMore.value || !nextCursor.value) return
    try {
      loading.value = true
      const res = await client.listAudit({
        ...lastParams,
        limit: 50,
        cursor: nextCursor.value,
      })
      events.value = [...events.value, ...res.items]
      hasMore.value = res.has_more
      nextCursor.value = res.next_cursor
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Error loading more audit events'
    } finally {
      loading.value = false
    }
  }

  async function exportAudit(params: AuditQueryParams, format: 'json' | 'csv'): Promise<void> {
    const client = auth.client
    if (!client) return
    try {
      exporting.value = true
      const { blob, filename } = await client.exportAudit({ ...params, format })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Export failed'
    } finally {
      exporting.value = false
    }
  }

  return {
    events,
    loading,
    error,
    hasMore,
    nextCursor,
    exporting,
    fetchAudit,
    loadMore,
    exportAudit,
  }
})
