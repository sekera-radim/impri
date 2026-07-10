import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useAuthStore } from './auth'
import type { Billing } from '../types'
import { ApiClientError } from '../api/client'

export const useBillingStore = defineStore('billing', () => {
  const auth = useAuthStore()

  const billing = ref<Billing | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchBilling(): Promise<void> {
    const client = auth.client
    if (!client) return
    try {
      loading.value = true
      error.value = null
      billing.value = await client.getBilling()
    } catch (err) {
      if (err instanceof ApiClientError && (err.status === 401 || err.status === 403)) {
        auth.logout()
      } else {
        error.value = err instanceof Error ? err.message : 'Unknown error loading billing'
      }
    } finally {
      loading.value = false
    }
  }

  async function checkout(plan: 'indie' | 'team', period: 'monthly' | 'yearly'): Promise<void> {
    const client = auth.client
    if (!client) throw new Error('Not authenticated')
    const { url } = await client.createCheckout(plan, period)
    window.location.href = url
  }

  async function portal(): Promise<void> {
    const client = auth.client
    if (!client) throw new Error('Not authenticated')
    const { url } = await client.openPortal()
    window.location.href = url
  }

  return {
    billing,
    loading,
    error,
    fetchBilling,
    checkout,
    portal,
  }
})
