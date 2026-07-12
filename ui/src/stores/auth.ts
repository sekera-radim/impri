import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { ApiClient, ApiClientError } from '../api/client'

const STORAGE_KEY = 'impri_api_key'

/**
 * Device pairing via QR: the key rides in the URL FRAGMENT (#k=…), never the
 * query string, so it is not sent to the server or written to access logs. We
 * read it once on load, persist it, and immediately strip it from the URL so it
 * doesn't linger in history or a shared screenshot.
 */
function readKeyFromHash(): string | null {
  const m = /[#&]k=([^&]+)/.exec(window.location.hash)
  if (!m) return null
  let key: string
  try {
    key = decodeURIComponent(m[1])
  } catch {
    return null
  }
  history.replaceState(null, '', window.location.pathname + window.location.search)
  return key
}

export const useAuthStore = defineStore('auth', () => {
  const pairedKey = readKeyFromHash()
  if (pairedKey) localStorage.setItem(STORAGE_KEY, pairedKey)
  const apiKey = ref<string | null>(pairedKey ?? localStorage.getItem(STORAGE_KEY))
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
