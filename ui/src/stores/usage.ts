import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useAuthStore } from './auth'
import type { UsageResponse } from '../types'
import { ApiClientError } from '../api/client'

export const useUsageStore = defineStore('usage', () => {
  const auth = useAuthStore()

  const usage = ref<UsageResponse | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  // true when the API key lacks admin scope (HTTP 403) — show a scope warning
  const noAdminScope = ref(false)

  async function fetchUsage(): Promise<void> {
    const client = auth.client
    if (!client) return
    try {
      loading.value = true
      error.value = null
      noAdminScope.value = false
      usage.value = await client.getUsage()
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.status === 401) {
          auth.logout()
        } else if (err.status === 403) {
          noAdminScope.value = true
        } else {
          error.value = err instanceof Error ? err.message : 'Unknown error loading usage'
        }
      } else {
        error.value = err instanceof Error ? err.message : 'Unknown error loading usage'
      }
    } finally {
      loading.value = false
    }
  }

  return {
    usage,
    loading,
    error,
    noAdminScope,
    fetchUsage,
  }
})
