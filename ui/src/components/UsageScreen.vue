<template>
  <div>
    <!-- Header -->
    <div class="d-flex align-center mb-4 gap-2">
      <span class="text-h6">Usage</span>
      <v-spacer />
      <v-btn
        icon="mdi-refresh"
        variant="text"
        size="small"
        title="Refresh usage"
        aria-label="Refresh usage"
        :loading="store.loading"
        @click="store.fetchUsage()"
      />
    </div>

    <!-- Loading skeleton on first load -->
    <template v-if="store.loading && !store.usage">
      <v-row class="mb-4">
        <v-col cols="12" sm="6">
          <v-skeleton-loader type="card" />
        </v-col>
        <v-col cols="12" sm="6">
          <v-skeleton-loader type="card" />
        </v-col>
      </v-row>
      <v-skeleton-loader type="card" />
    </template>

    <!-- Admin scope required -->
    <v-alert
      v-else-if="store.noAdminScope"
      type="info"
      variant="tonal"
      icon="mdi-shield-key-outline"
      class="mb-4"
    >
      <strong>Admin scope required.</strong>
      Usage data is only available to API keys with the <code>admin</code> scope.
      Log in with an admin key to see this view.
    </v-alert>

    <!-- Fetch error -->
    <v-alert
      v-else-if="store.error"
      type="error"
      variant="tonal"
      density="compact"
      class="mb-4"
      closable
      @click:close="store.error = null"
    >
      {{ store.error }}
    </v-alert>

    <template v-else-if="store.usage">
      <!-- Period + tier row -->
      <div class="d-flex align-center flex-wrap gap-2 mb-5">
        <v-icon size="18" color="medium-emphasis" class="mr-1">mdi-calendar-range-outline</v-icon>
        <span class="text-body-2 text-medium-emphasis">
          Period: <strong>{{ formatPeriod(store.usage.period.start, store.usage.period.end) }}</strong>
        </span>
        <v-chip
          :color="tierColor(store.usage.tier)"
          size="x-small"
          label
          variant="tonal"
          class="text-capitalize"
        >
          {{ store.usage.tier }}
        </v-chip>
        <v-chip
          v-if="store.usage.subscription_status && store.usage.subscription_status !== 'none'"
          :color="statusColor(store.usage.subscription_status)"
          size="x-small"
          label
          variant="tonal"
        >
          {{ store.usage.subscription_status.replace('_', ' ') }}
        </v-chip>
        <span
          v-if="store.usage.current_period_end"
          class="text-caption text-medium-emphasis"
        >
          Renews {{ formatDate(store.usage.current_period_end) }}
        </span>
      </div>

      <!-- DLQ warning — surfaces prominently when non-zero -->
      <v-alert
        v-if="store.usage.webhook_delivery.dlq_size > 0"
        type="warning"
        variant="tonal"
        icon="mdi-alert-circle-outline"
        density="compact"
        class="mb-5"
      >
        <strong>{{ store.usage.webhook_delivery.dlq_size }}</strong>
        webhook{{ store.usage.webhook_delivery.dlq_size !== 1 ? 's' : '' }}
        in the dead-letter queue. Check your callback endpoint and retry from the audit log.
      </v-alert>

      <!-- Row 1: Approvals + Watchers -->
      <v-row class="mb-1">
        <!-- Approvals card -->
        <v-col cols="12" sm="6">
          <v-card variant="outlined" class="h-100">
            <v-card-text>
              <div class="d-flex align-center mb-3 gap-2">
                <v-icon size="18" color="primary">mdi-check-circle-outline</v-icon>
                <span class="text-caption text-uppercase font-weight-medium letter-spaced text-medium-emphasis">
                  Approvals this period
                </span>
              </div>

              <div class="d-flex align-baseline gap-2 mb-1">
                <span class="stat-number">{{ store.usage.approvals.used }}</span>
                <span class="text-body-2 text-medium-emphasis">
                  /
                  <template v-if="store.usage.approvals.limit !== null">
                    {{ store.usage.approvals.limit }}
                  </template>
                  <template v-else>unlimited</template>
                </span>
              </div>

              <v-progress-linear
                v-if="store.usage.approvals.limit !== null"
                :model-value="usagePercent(store.usage.approvals.used, store.usage.approvals.limit)"
                :color="usageColor(usagePercent(store.usage.approvals.used, store.usage.approvals.limit))"
                bg-color="surface-variant"
                rounded
                height="5"
                class="mb-3"
              />
              <div v-else class="mb-3" />

              <div class="text-caption text-medium-emphasis">
                <template v-if="store.usage.approvals.limit === null">
                  Unlimited on this plan
                </template>
                <template v-else-if="store.usage.approvals.remaining !== null">
                  <span :class="remainingClass(store.usage.approvals.remaining, store.usage.approvals.limit)">
                    {{ store.usage.approvals.remaining }} remaining
                  </span>
                  this month
                </template>
              </div>
            </v-card-text>
          </v-card>
        </v-col>

        <!-- Watchers card -->
        <v-col cols="12" sm="6">
          <v-card variant="outlined" class="h-100">
            <v-card-text>
              <div class="d-flex align-center mb-3 gap-2">
                <v-icon size="18" color="primary">mdi-eye-outline</v-icon>
                <span class="text-caption text-uppercase font-weight-medium letter-spaced text-medium-emphasis">
                  Watcher slots
                </span>
              </div>

              <div class="d-flex align-baseline gap-2 mb-1">
                <span class="stat-number">{{ store.usage.watchers.active }}</span>
                <span class="text-body-2 text-medium-emphasis">
                  active /
                  <template v-if="store.usage.watchers.limit !== null">
                    {{ store.usage.watchers.limit }}
                  </template>
                  <template v-else>unlimited</template>
                </span>
              </div>

              <v-progress-linear
                v-if="store.usage.watchers.limit !== null"
                :model-value="usagePercent(store.usage.watchers.active, store.usage.watchers.limit)"
                :color="usageColor(usagePercent(store.usage.watchers.active, store.usage.watchers.limit))"
                bg-color="surface-variant"
                rounded
                height="5"
                class="mb-3"
              />
              <div v-else class="mb-3" />

              <!-- Watcher status breakdown -->
              <div class="d-flex flex-wrap gap-1">
                <v-chip
                  v-if="store.usage.watchers.active > 0"
                  size="x-small"
                  color="success"
                  variant="tonal"
                  label
                >
                  {{ store.usage.watchers.active }} active
                </v-chip>
                <v-chip
                  v-if="store.usage.watchers.degraded > 0"
                  size="x-small"
                  color="warning"
                  variant="tonal"
                  label
                >
                  {{ store.usage.watchers.degraded }} degraded
                </v-chip>
                <v-chip
                  v-if="store.usage.watchers.paused > 0"
                  size="x-small"
                  color="secondary"
                  variant="tonal"
                  label
                >
                  {{ store.usage.watchers.paused }} paused
                </v-chip>
                <span
                  v-if="store.usage.watchers.total === 0"
                  class="text-caption text-medium-emphasis"
                >
                  No watchers yet
                </span>
              </div>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>

      <!-- Row 2: Action breakdown -->
      <v-card variant="outlined" class="mb-4">
        <v-card-text>
          <div class="d-flex align-center mb-4 gap-2">
            <v-icon size="18" color="primary">mdi-inbox-outline</v-icon>
            <span class="text-caption text-uppercase font-weight-medium letter-spaced text-medium-emphasis">
              Actions this period
            </span>
            <v-spacer />
            <span class="text-h6 font-weight-bold tabular-nums">
              {{ store.usage.actions.created_this_period }}
            </span>
            <span class="text-body-2 text-medium-emphasis">created</span>
          </div>

          <v-row class="action-stat-row" no-gutters>
            <v-col
              v-for="stat in actionStats"
              :key="stat.label"
              class="action-stat-cell"
            >
              <div class="action-stat-number" :style="{ color: stat.textColor }">
                {{ stat.value }}
              </div>
              <div class="action-stat-label">
                <v-chip
                  :color="stat.color"
                  size="x-small"
                  label
                  variant="tonal"
                >
                  {{ stat.label }}
                </v-chip>
              </div>
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>

      <!-- Row 3: Webhook delivery + Limits -->
      <v-row>
        <!-- Webhook delivery -->
        <v-col cols="12" sm="6">
          <v-card variant="outlined" class="h-100">
            <v-card-text>
              <div class="d-flex align-center mb-3 gap-2">
                <v-icon size="18" color="primary">mdi-webhook</v-icon>
                <span class="text-caption text-uppercase font-weight-medium letter-spaced text-medium-emphasis">
                  Webhook delivery
                </span>
              </div>
              <div class="d-flex flex-column gap-2">
                <div class="d-flex justify-space-between align-center">
                  <span class="text-body-2 text-medium-emphasis">Pending</span>
                  <span class="text-body-2 font-weight-medium tabular-nums">
                    {{ store.usage.webhook_delivery.pending }}
                  </span>
                </div>
                <v-divider />
                <div class="d-flex justify-space-between align-center">
                  <span class="text-body-2 text-medium-emphasis">In retry</span>
                  <span class="text-body-2 font-weight-medium tabular-nums">
                    {{ store.usage.webhook_delivery.in_retry }}
                  </span>
                </div>
                <v-divider />
                <div class="d-flex justify-space-between align-center">
                  <span class="text-body-2 text-medium-emphasis">Dead-letter queue</span>
                  <span
                    class="text-body-2 font-weight-medium tabular-nums"
                    :class="store.usage.webhook_delivery.dlq_size > 0 ? 'text-warning' : ''"
                  >
                    {{ store.usage.webhook_delivery.dlq_size }}
                  </span>
                </div>
              </div>
            </v-card-text>
          </v-card>
        </v-col>

        <!-- Plan limits -->
        <v-col cols="12" sm="6">
          <v-card variant="outlined" class="h-100">
            <v-card-text>
              <div class="d-flex align-center mb-3 gap-2">
                <v-icon size="18" color="primary">mdi-gauge-low</v-icon>
                <span class="text-caption text-uppercase font-weight-medium letter-spaced text-medium-emphasis">
                  Plan limits
                </span>
              </div>
              <div class="d-flex flex-column gap-2">
                <div class="d-flex justify-space-between align-center">
                  <span class="text-body-2 text-medium-emphasis">Approvals / month</span>
                  <span class="text-body-2 font-weight-medium tabular-nums">
                    <template v-if="store.usage.limits.approvals_per_month !== null">
                      {{ store.usage.limits.approvals_per_month.toLocaleString() }}
                    </template>
                    <template v-else>
                      <span class="text-medium-emphasis">unlimited</span>
                    </template>
                  </span>
                </div>
                <v-divider />
                <div class="d-flex justify-space-between align-center">
                  <span class="text-body-2 text-medium-emphasis">Watcher slots</span>
                  <span class="text-body-2 font-weight-medium tabular-nums">
                    <template v-if="store.usage.limits.watchers !== null">
                      {{ store.usage.limits.watchers }}
                    </template>
                    <template v-else>
                      <span class="text-medium-emphasis">unlimited</span>
                    </template>
                  </span>
                </div>
                <v-divider />
                <div class="d-flex justify-space-between align-center">
                  <span class="text-body-2 text-medium-emphasis">Min check interval</span>
                  <span class="text-body-2 font-weight-medium tabular-nums">
                    {{ formatInterval(store.usage.limits.min_watcher_interval_sec) }}
                  </span>
                </div>
              </div>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>

      <!-- Refresh timestamp -->
      <div class="text-center text-caption text-medium-emphasis mt-4">
        Fetched {{ formatRelative(store.usage.ts) }}
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useUsageStore } from '../stores/usage'
import { usagePercent, usageColor } from '../utils/billing'

const store = useUsageStore()

// ─── Action stats ────────────────────────────────────────────────────────────

const actionStats = computed(() => {
  if (!store.usage) return []
  const { pending, approved, rejected, expired } = store.usage.actions
  return [
    { label: 'pending',  value: pending,  color: 'primary', textColor: 'rgb(var(--v-theme-primary))' },
    { label: 'approved', value: approved, color: 'success', textColor: 'rgb(var(--v-theme-success))' },
    { label: 'rejected', value: rejected, color: 'error',   textColor: 'rgb(var(--v-theme-error))' },
    { label: 'expired',  value: expired,  color: 'warning', textColor: 'rgb(var(--v-theme-warning))' },
  ]
})

// ─── Remaining indicator class ────────────────────────────────────────────────

function remainingClass(remaining: number, limit: number | null): string {
  if (limit === null || limit === 0) return ''
  const pct = (remaining / limit) * 100
  if (pct <= 10) return 'text-error font-weight-medium'
  if (pct <= 30) return 'text-warning font-weight-medium'
  return ''
}

// ─── Chip color helpers ───────────────────────────────────────────────────────

function tierColor(tier: string): string {
  if (tier === 'team') return 'deep-purple'
  if (tier === 'indie') return 'primary'
  return 'secondary'
}

function statusColor(status: string): string {
  if (status === 'active') return 'success'
  if (status === 'past_due') return 'warning'
  if (status === 'canceled') return 'error'
  return 'secondary'
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function formatPeriod(startTs: number, endTs: number): string {
  const start = new Date(startTs * 1000)
  const end = new Date(endTs * 1000)
  // Show "Jul 2026" when start and end are in the same year/month,
  // otherwise show "Jul – Aug 2026" for non-calendar-month periods.
  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
  const fmtStart = new Date(startTs * 1000)
  const nextMonthStart = new Date(endTs * 1000)
  if (
    fmtStart.getUTCFullYear() === nextMonthStart.getUTCFullYear() &&
    fmtStart.getUTCMonth() + 1 === nextMonthStart.getUTCMonth()
  ) {
    // Common case: calendar month
    return fmt(start)
  }
  return `${fmt(start)} – ${fmt(end)}`
}

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function formatInterval(sec: number): string {
  if (sec < 60) return `${sec}s`
  const mins = sec / 60
  if (mins < 60) return `${mins}m`
  return `${mins / 60}h`
}

function formatRelative(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts
  if (diff < 5) return 'just now'
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

onMounted(() => {
  void store.fetchUsage()
})
</script>

<style scoped>
.gap-1 { gap: 4px; }
.gap-2 { gap: 8px; }

/* Stat number in the approvals / watchers cards */
.stat-number {
  font-size: 2.25rem;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

/* Uppercase section labels */
.letter-spaced {
  letter-spacing: 0.06em;
}

/* Tabular numerics for metric values */
.tabular-nums {
  font-variant-numeric: tabular-nums;
}

/* Action breakdown row: equally divided cells */
.action-stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0;
}

.action-stat-cell {
  flex: 1 1 0;
  min-width: 64px;
  text-align: center;
  padding: 4px 8px;
  border-right: 1px solid rgba(128, 128, 128, 0.1);
}

.action-stat-cell:last-child {
  border-right: none;
}

.action-stat-number {
  font-size: 1.75rem;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  margin-bottom: 6px;
}

.action-stat-label {
  display: flex;
  justify-content: center;
}
</style>
