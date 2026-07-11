import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useAuthStore } from './auth'
import { ApiClientError } from '../api/client'
import type {
  NotificationChannel,
  CreateChannelRequest,
  UpdateChannelRequest,
  TestChannelResponse,
} from '../types'

export const useChannelsStore = defineStore('channels', () => {
  const auth = useAuthStore()

  const channels = ref<NotificationChannel[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchChannels(): Promise<void> {
    const client = auth.client
    if (!client) return
    try {
      loading.value = true
      error.value = null
      const res = await client.listChannels()
      channels.value = res.items
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.status === 401) {
          auth.logout()
        } else if (err.status === 403) {
          // Admin scope required; don't log out — just surface the message so
          // the user knows they need an admin key to manage channels.
          error.value = 'Notification channels require an admin-scope API key.'
        } else {
          error.value = err.body.message ?? err.message
        }
      } else {
        error.value = err instanceof Error ? err.message : 'Unknown error loading channels'
      }
    } finally {
      loading.value = false
    }
  }

  async function createChannel(req: CreateChannelRequest): Promise<NotificationChannel> {
    const client = auth.client
    if (!client) throw new Error('Not authenticated')
    const ch = await client.createChannel(req)
    channels.value.unshift(ch)
    return ch
  }

  async function updateChannel(id: string, req: UpdateChannelRequest): Promise<NotificationChannel> {
    const client = auth.client
    if (!client) throw new Error('Not authenticated')
    const updated = await client.updateChannel(id, req)
    replaceChannel(updated)
    return updated
  }

  async function deleteChannel(id: string): Promise<void> {
    const client = auth.client
    if (!client) return
    await client.deleteChannel(id)
    channels.value = channels.value.filter((c) => c.id !== id)
  }

  async function testChannel(id: string): Promise<TestChannelResponse> {
    const client = auth.client
    if (!client) throw new Error('Not authenticated')
    return client.testChannel(id)
  }

  function replaceChannel(updated: NotificationChannel): void {
    const idx = channels.value.findIndex((c) => c.id === updated.id)
    if (idx !== -1) {
      channels.value[idx] = updated
    }
  }

  return {
    channels,
    loading,
    error,
    fetchChannels,
    createChannel,
    updateChannel,
    deleteChannel,
    testChannel,
  }
})
