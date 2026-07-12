<template>
  <v-dialog :model-value="open" max-width="380" @update:model-value="$emit('close')">
    <v-card>
      <v-card-title class="d-flex align-center">
        <v-icon start size="20">mdi-cellphone-link</v-icon>
        Connect a device
        <v-spacer />
        <v-btn icon="mdi-close" variant="text" size="small" @click="$emit('close')" />
      </v-card-title>

      <v-card-text class="text-center">
        <p class="text-body-2 text-medium-emphasis mb-4">
          Scan this with your phone's camera to open Impri already signed in — no
          key to type.
        </p>

        <div v-if="qrDataUrl" class="qr-wrap mx-auto mb-4">
          <img :src="qrDataUrl" alt="Login QR code" width="240" height="240" />
        </div>
        <div v-else class="py-8">
          <v-progress-circular indeterminate color="primary" />
        </div>

        <v-alert type="warning" variant="tonal" density="compact" class="text-left">
          This QR grants full access to your inbox. Only scan it with your own
          device, and don't share a screenshot.
        </v-alert>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import QRCode from 'qrcode'
import { useAuthStore } from '../stores/auth'

const props = defineProps<{ open: boolean }>()
defineEmits<{ close: [] }>()

const auth = useAuthStore()
const qrDataUrl = ref<string | null>(null)

async function generate(): Promise<void> {
  qrDataUrl.value = null
  const key = auth.apiKey
  if (!key) return
  // Key rides in the fragment (#k=) so it is never sent to the server. The app
  // reads it on load, stores it, and strips it from the URL (see auth store).
  const url = `${window.location.origin}/#k=${encodeURIComponent(key)}`
  qrDataUrl.value = await QRCode.toDataURL(url, { width: 240, margin: 1 })
}

watch(
  () => props.open,
  (open) => {
    if (open) void generate()
    else qrDataUrl.value = null
  },
)
</script>

<style scoped>
.qr-wrap {
  width: 240px;
  padding: 8px;
  background: #fff;
  border-radius: 8px;
}
</style>
