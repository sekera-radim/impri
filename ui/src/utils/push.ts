import type { ApiClient } from '../api/client'

export function isPushSupported(): boolean {
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

// Converts a URL-safe base64 VAPID public key to the Uint8Array that
// PushManager.subscribe() expects as applicationServerKey.
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return Uint8Array.from(rawData, (char) => char.charCodeAt(0))
}

export async function subscribeToPush(apiClient: ApiClient): Promise<void> {
  if (!isPushSupported()) {
    throw new Error('Push notifications are not supported in this browser.')
  }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error('Notification permission was denied.')
  }

  const { enabled, public_key } = await apiClient.getVapidPublicKey()
  if (!enabled || !public_key) {
    throw new Error('Push notifications are not enabled on this server.')
  }

  const registration = await navigator.serviceWorker.register('/sw.js')

  const applicationServerKey = urlBase64ToUint8Array(public_key)
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  })

  const sub = subscription.toJSON() as {
    endpoint: string
    keys: { p256dh: string; auth: string }
  }

  await apiClient.pushSubscribe({
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
  })
}

export async function unsubscribeFromPush(apiClient: ApiClient): Promise<void> {
  if (!isPushSupported()) return

  const registration = await navigator.serviceWorker.getRegistration('/sw.js')
  if (!registration) return

  const subscription = await registration.pushManager.getSubscription()
  if (!subscription) return

  const endpoint = subscription.endpoint
  await subscription.unsubscribe()
  await apiClient.pushUnsubscribe(endpoint)
}
