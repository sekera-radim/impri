<template>
  <div>
    <!-- Header -->
    <div class="d-flex align-center mb-4 gap-2">
      <span class="text-h6">Billing &amp; Plan</span>
      <v-spacer />
      <v-btn
        icon="mdi-refresh"
        variant="text"
        size="small"
        :loading="store.loading"
        @click="store.fetchBilling()"
      />
    </div>

    <!-- Loading skeleton on first load -->
    <template v-if="store.loading && !store.billing">
      <v-skeleton-loader type="card" class="mb-4" />
      <v-skeleton-loader type="card" />
    </template>

    <!-- Fetch error -->
    <v-alert
      v-if="store.error"
      type="error"
      variant="tonal"
      density="compact"
      class="mb-4"
      closable
      @click:close="store.error = null"
    >
      {{ store.error }}
    </v-alert>

    <!-- Action error (checkout / portal) -->
    <v-alert
      v-if="actionError"
      type="error"
      variant="tonal"
      density="compact"
      class="mb-4"
      closable
      @click:close="actionError = null"
    >
      {{ actionError }}
    </v-alert>

    <template v-if="store.billing">
      <!-- Self-hosted banner -->
      <v-alert
        v-if="!store.billing.billing_enabled"
        type="info"
        variant="tonal"
        icon="mdi-server"
        class="mb-6"
      >
        <strong>Self-hosted</strong> — all features free, no billing.
      </v-alert>

      <!-- Current plan card -->
      <v-card variant="outlined" class="mb-6">
        <v-card-title class="text-body-1 font-weight-semibold pb-0">Current plan</v-card-title>
        <v-card-text>
          <div class="d-flex align-center flex-wrap gap-2 mb-5">
            <span class="text-h5 text-capitalize font-weight-bold">{{ store.billing.tier }}</span>
            <v-chip :color="statusColor(store.billing.status)" size="small" variant="tonal" label>
              {{ store.billing.status.replace('_', ' ') }}
            </v-chip>
            <span v-if="store.billing.current_period_end" class="text-caption text-medium-emphasis">
              Renews {{ formatDate(store.billing.current_period_end) }}
            </span>
          </div>

          <!-- Watchers usage bar -->
          <div class="mb-4">
            <div class="d-flex justify-space-between text-caption mb-1">
              <span>Watchers</span>
              <span class="text-medium-emphasis">
                <template v-if="store.billing.usage.watchers.limit !== null">
                  {{ store.billing.usage.watchers.used }} / {{ store.billing.usage.watchers.limit }}
                </template>
                <template v-else>
                  {{ store.billing.usage.watchers.used }} / unlimited
                </template>
              </span>
            </div>
            <v-progress-linear
              :model-value="usagePercent(store.billing.usage.watchers.used, store.billing.usage.watchers.limit)"
              :color="usageColor(usagePercent(store.billing.usage.watchers.used, store.billing.usage.watchers.limit))"
              bg-color="surface-variant"
              rounded
              height="6"
            />
          </div>

          <!-- Approvals usage bar -->
          <div>
            <div class="d-flex justify-space-between text-caption mb-1">
              <span>Approvals this month</span>
              <span class="text-medium-emphasis">
                <template v-if="store.billing.usage.approvals.limit !== null">
                  {{ store.billing.usage.approvals.used }} / {{ store.billing.usage.approvals.limit }}
                </template>
                <template v-else>
                  {{ store.billing.usage.approvals.used }} / unlimited
                </template>
              </span>
            </div>
            <v-progress-linear
              :model-value="usagePercent(store.billing.usage.approvals.used, store.billing.usage.approvals.limit)"
              :color="usageColor(usagePercent(store.billing.usage.approvals.used, store.billing.usage.approvals.limit))"
              bg-color="surface-variant"
              rounded
              height="6"
            />
          </div>
        </v-card-text>
      </v-card>

      <!-- Plan cards (only when billing is enabled) -->
      <template v-if="store.billing.billing_enabled">
        <!-- Period toggle -->
        <div class="d-flex align-center justify-end mb-4 gap-2">
          <span class="text-body-2">Monthly</span>
          <v-switch
            v-model="yearlyBilling"
            density="compact"
            hide-details
            color="primary"
            class="flex-grow-0"
          />
          <span class="text-body-2">
            Yearly
            <v-chip size="x-small" color="success" variant="tonal" label class="ml-1">save ~15%</v-chip>
          </span>
        </div>

        <!-- Plan cards -->
        <v-row class="mb-4">
          <v-col
            v-for="plan in plans"
            :key="plan.id"
            cols="12"
            sm="4"
          >
            <v-card
              variant="outlined"
              :class="['plan-card h-100', { 'plan-card--current': store.billing.tier === plan.id }]"
            >
              <v-card-text class="d-flex flex-column h-100">
                <div class="text-h6 font-weight-bold mb-1">{{ plan.name }}</div>
                <div class="mb-3">
                  <span class="text-h5 font-weight-bold">
                    {{ yearlyBilling && plan.yearlyPrice ? plan.yearlyPrice : plan.monthlyPrice }}
                  </span>
                  <span v-if="plan.id !== 'free'" class="text-caption text-medium-emphasis ml-1">
                    {{ yearlyBilling ? '/yr' : '/mo' }}
                  </span>
                </div>

                <v-list density="compact" class="flex-grow-1 pa-0 mb-4">
                  <v-list-item
                    v-for="feature in plan.features"
                    :key="feature"
                    class="px-0"
                    min-height="28"
                  >
                    <template #prepend>
                      <v-icon size="14" color="success" class="mr-2">mdi-check</v-icon>
                    </template>
                    <v-list-item-title class="text-body-2">{{ feature }}</v-list-item-title>
                  </v-list-item>
                </v-list>

                <!-- Current plan chip -->
                <div v-if="store.billing.tier === plan.id" class="d-flex justify-center">
                  <v-chip color="primary" variant="tonal" label>Current plan</v-chip>
                </div>

                <!-- Upgrade button (not free, not current) -->
                <v-btn
                  v-else-if="plan.id !== 'free'"
                  color="primary"
                  variant="flat"
                  block
                  :loading="checkingOut === plan.id"
                  @click="upgradeToPlan(plan.id as 'indie' | 'team')"
                >
                  Upgrade
                </v-btn>
              </v-card-text>
            </v-card>
          </v-col>
        </v-row>

        <!-- Manage billing -->
        <div class="d-flex justify-end">
          <v-btn
            variant="outlined"
            prepend-icon="mdi-credit-card-outline"
            :loading="openingPortal"
            @click="openPortal"
          >
            Manage billing
          </v-btn>
        </div>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useBillingStore } from '../stores/billing'
import { usagePercent, usageColor } from '../utils/billing'

const store = useBillingStore()

// ─── Status helpers ────────────────────────────────────────────────────────────

function statusColor(status: string): string {
  switch (status) {
    case 'active': return 'success'
    case 'past_due': return 'warning'
    case 'canceled': return 'error'
    default: return 'grey'
  }
}

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

// ─── Period toggle ─────────────────────────────────────────────────────────────

const yearlyBilling = ref(false)

// ─── Plan definitions ──────────────────────────────────────────────────────────

const plans = [
  {
    id: 'free',
    name: 'Free',
    monthlyPrice: 'Free',
    yearlyPrice: null as string | null,
    features: [
      '3 watchers',
      '100 approvals / month',
      'Email + ntfy notifications',
      '7 days history',
    ],
  },
  {
    id: 'indie',
    name: 'Indie',
    monthlyPrice: '$9',
    yearlyPrice: '$97',
    features: [
      '20 watchers',
      '2,000 approvals / month',
      'Push notifications',
      '90 days history',
      'Priority webhooks',
    ],
  },
  {
    id: 'team',
    name: 'Team',
    monthlyPrice: '$29',
    yearlyPrice: '$290',
    features: [
      'Unlimited watchers',
      'Unlimited approvals',
      '5 team members',
      'Audit export',
      '1 year history',
    ],
  },
]

// ─── Actions ──────────────────────────────────────────────────────────────────

const checkingOut = ref<string | null>(null)
const openingPortal = ref(false)
const actionError = ref<string | null>(null)

async function upgradeToPlan(plan: 'indie' | 'team'): Promise<void> {
  checkingOut.value = plan
  actionError.value = null
  try {
    await store.checkout(plan, yearlyBilling.value ? 'yearly' : 'monthly')
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : 'Failed to start checkout'
  } finally {
    checkingOut.value = null
  }
}

async function openPortal(): Promise<void> {
  openingPortal.value = true
  actionError.value = null
  try {
    await store.portal()
  } catch (err) {
    actionError.value = err instanceof Error ? err.message : 'Failed to open billing portal'
  } finally {
    openingPortal.value = false
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

onMounted(() => {
  void store.fetchBilling()
})
</script>

<style scoped>
.plan-card {
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  transition: border-color 0.15s;
}

.plan-card--current {
  border-color: rgb(var(--v-theme-primary));
}

.gap-2 { gap: 8px; }
</style>
