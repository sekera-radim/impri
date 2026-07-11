import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useAuthStore } from './auth'
import type { Watcher, CreateWatcherRequest, CreateWatcherFromPresetRequest, UpdateWatcherRequest } from '../types'
import { ApiClientError } from '../api/client'

export const useWatchersStore = defineStore('watchers', () => {
  const auth = useAuthStore()

  const watchers = ref<Watcher[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchWatchers(): Promise<void> {
    const client = auth.client
    if (!client) return
    try {
      loading.value = true
      error.value = null
      const res = await client.listWatchers({ limit: 100 })
      watchers.value = res.items
    } catch (err) {
      if (err instanceof ApiClientError && (err.status === 401 || err.status === 403)) {
        auth.logout()
      } else {
        error.value = err instanceof Error ? err.message : 'Unknown error loading watchers'
      }
    } finally {
      loading.value = false
    }
  }

  async function createWatcher(req: CreateWatcherRequest): Promise<Watcher> {
    const client = auth.client
    if (!client) throw new Error('Not authenticated')
    const watcher = await client.createWatcher(req)
    watchers.value.unshift(watcher)
    return watcher
  }

  async function createWatcherFromPreset(req: CreateWatcherFromPresetRequest): Promise<Watcher> {
    const client = auth.client
    if (!client) throw new Error('Not authenticated')
    const watcher = await client.createWatcherFromPreset(req)
    watchers.value.unshift(watcher)
    return watcher
  }

  async function editWatcher(id: string, req: UpdateWatcherRequest): Promise<Watcher> {
    const client = auth.client
    if (!client) throw new Error('Not authenticated')
    const updated = await client.updateWatcher(id, req)
    replaceWatcher(updated)
    return updated
  }

  async function pauseWatcher(id: string): Promise<void> {
    const client = auth.client
    if (!client) return
    const updated = await client.updateWatcher(id, { status: 'paused' })
    replaceWatcher(updated)
  }

  async function activateWatcher(id: string): Promise<void> {
    const client = auth.client
    if (!client) return
    const updated = await client.updateWatcher(id, { status: 'active' })
    replaceWatcher(updated)
  }

  async function deleteWatcher(id: string): Promise<void> {
    const client = auth.client
    if (!client) return
    await client.deleteWatcher(id)
    watchers.value = watchers.value.filter((w) => w.id !== id)
  }

  function replaceWatcher(updated: Watcher): void {
    const idx = watchers.value.findIndex((w) => w.id === updated.id)
    if (idx !== -1) {
      watchers.value[idx] = updated
    }
  }

  return {
    watchers,
    loading,
    error,
    fetchWatchers,
    createWatcher,
    createWatcherFromPreset,
    editWatcher,
    pauseWatcher,
    activateWatcher,
    deleteWatcher,
  }
})
