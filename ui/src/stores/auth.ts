import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { ApiClient, ApiClientError } from '../api/client'

const STORAGE_KEY = 'impri_api_key'

export const useAuthStore = defineStore('auth', () => {
  const apiKey = ref<string | null>(localStorage.getItem(STORAGE_KEY))
  const loginError = ref<string | null>(null)
  const loggingIn = ref(false)

  const isLoggedIn = computed(() => apiKey.value !== null)

  const client = computed<ApiClient | null>(() =>
    apiKey.value ? new ApiClient(apiKey.value) : null,
  )

  async function login(key: string): Promise<boolean> {
    loggingIn.value = true
    loginError.value = null
    try {
      // Verify the key works by listing actions (or listing keys if admin)
      const testClient = new ApiClient(key)
      await testClient.listActions({ limit: 1 })
      apiKey.value = key
      localStorage.setItem(STORAGE_KEY, key)
      return true
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.status === 401) {
          loginError.value = 'Invalid API key — make sure it starts with im_ and has the "actions" scope.'
        } else if (err.status === 403) {
          loginError.value = 'This API key does not have the "actions" scope required for the inbox.'
        } else {
          loginError.value = `Server error (${err.status}): ${err.message}`
        }
      } else {
        const rawBase = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/v1'
        const isRemote = rawBase.startsWith('http')
        loginError.value = isRemote
          ? 'Could not reach the Impri server.'
          : 'Could not reach the Impri server. Make sure it is running on port 8484.'
      }
      return false
    } finally {
      loggingIn.value = false
    }
  }

  function logout(): void {
    apiKey.value = null
    loginError.value = null
    localStorage.removeItem(STORAGE_KEY)
  }

  return { apiKey, loginError, loggingIn, isLoggedIn, client, login, logout }
})
