<template>
  <v-card
    variant="outlined"
    class="action-card mb-2"
    :class="{ 'action-card--pending': action.status === 'pending' }"
    @click="$emit('click')"
  >
    <v-card-text class="py-3 px-4">
      <div class="d-flex align-start gap-3">
        <div class="flex-grow-1 min-width-0">
          <!-- Title + kind -->
          <div class="d-flex align-center flex-wrap gap-2 mb-1">
            <v-chip size="x-small" variant="tonal" color="secondary" label>
              {{ action.kind }}
            </v-chip>
            <v-chip
              v-if="isUntrusted"
              size="x-small"
              variant="tonal"
              color="warning"
              label
              prepend-icon="mdi-alert-outline"
            >
              External content
            </v-chip>
            <span class="text-body-2 font-weight-medium text-truncate">
              {{ action.title }}
            </span>
          </div>

          <!-- Preview excerpt (plain text only — no v-html) -->
          <p class="text-body-2 text-medium-emphasis preview-excerpt mb-1">
            {{ previewExcerpt }}
          </p>

          <!-- Meta row -->
          <div class="d-flex align-center flex-wrap gap-3 text-caption text-medium-emphasis">
            <span v-if="action.target_url" class="d-flex align-center gap-1">
              <v-icon size="12">mdi-link</v-icon>
              {{ targetDomain }}
            </span>
            <span v-if="action.expires_at" class="d-flex align-center gap-1" :class="{ 'text-error': isExpiringSoon }">
              <v-icon size="12">mdi-clock-outline</v-icon>
              {{ expiresLabel }}
            </span>
            <span class="d-flex align-center gap-1">
              <v-icon size="12">mdi-calendar-outline</v-icon>
              {{ createdLabel }}
            </span>
          </div>
        </div>

        <!-- Status chip -->
        <v-chip :color="statusColor" size="small" variant="tonal" class="flex-shrink-0">
          {{ action.status }}
        </v-chip>
      </div>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Action } from '../types'
import { isUntrustedPayload } from '../utils/untrusted'

const props = defineProps<{ action: Action }>()
defineEmits<{ click: [] }>()

const isUntrusted = computed(() => isUntrustedPayload(props.action.payload))

const previewExcerpt = computed(() => {
  const body = props.action.preview.body
  return body.length > 120 ? body.slice(0, 120) + '…' : body
})

const targetDomain = computed(() => {
  if (!props.action.target_url) return ''
  try {
    return new URL(props.action.target_url).hostname
  } catch {
    return props.action.target_url
  }
})

const nowSec = Math.floor(Date.now() / 1000)

const isExpiringSoon = computed(() => {
  if (!props.action.expires_at) return false
  return props.action.expires_at - nowSec < 3600
})

const expiresLabel = computed(() => {
  if (!props.action.expires_at) return ''
  const diffSec = props.action.expires_at - nowSec
  if (diffSec <= 0) return 'expired'
  if (diffSec < 60) return `${diffSec}s`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`
  return `${Math.floor(diffSec / 86400)}d`
})

const createdLabel = computed(() => {
  const d = new Date(props.action.created_at * 1000)
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
})

const statusColor = computed(() => {
  switch (props.action.status) {
    case 'pending': return 'warning'
    case 'approved': return 'success'
    case 'rejected': return 'error'
    case 'expired': return 'grey'
    case 'executed': return 'info'
    case 'execute_failed': return 'deep-orange'
    default: return 'grey'
  }
})
</script>

<style scoped>
.action-card {
  cursor: pointer;
  transition: border-color 0.15s;
}

.action-card:hover {
  border-color: rgba(var(--v-theme-primary), 0.5);
}

.action-card--pending {
  border-left: 3px solid rgb(var(--v-theme-warning));
}

.preview-excerpt {
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  font-size: 0.8rem;
}

.min-width-0 {
  min-width: 0;
}

.gap-1 { gap: 4px; }
.gap-2 { gap: 8px; }
.gap-3 { gap: 12px; }
</style>
