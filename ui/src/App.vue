<template>
  <v-app>
    <!-- Animated aurora backdrop, behind everything, works in both themes -->
    <div class="app-bg" aria-hidden="true">
      <span class="orb orb-1"></span>
      <span class="orb orb-2"></span>
      <span class="orb orb-3"></span>
    </div>

    <!-- Login screen (not authenticated) -->
    <template v-if="!auth.isLoggedIn">
      <LoginScreen />
    </template>

    <!-- Main app (authenticated) -->
    <template v-else>
      <v-app-bar elevation="0" density="compact">
        <v-app-bar-title>
          <span class="font-weight-bold">Impri</span>
          <span class="text-medium-emphasis text-body-2 ml-2">Approval Inbox</span>
        </v-app-bar-title>

        <template #append>
          <v-btn
            icon="mdi-help-circle-outline"
            title="How Impri works"
            aria-label="How Impri works"
            variant="text"
            size="small"
            @click="openHelp"
          />
          <v-btn
            :icon="isDark ? 'mdi-weather-sunny' : 'mdi-weather-night'"
            :title="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
            :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
            variant="text"
            size="small"
            @click="toggleTheme"
          />
          <v-btn
            variant="text"
            size="small"
            prepend-icon="mdi-logout"
            @click="auth.logout()"
          >
            Sign out
          </v-btn>
        </template>

        <!-- Primary nav lives in the app-bar extension so it renders below the
             title row, not behind the fixed bar. -->
        <template #extension>
          <v-tabs v-model="activeTab" density="compact" color="primary" align-tabs="start">
            <v-tab value="inbox">
              Inbox
              <v-badge
                v-if="pendingTotal > 0"
                :content="pendingTotal"
                color="error"
                inline
                class="ml-1"
              />
            </v-tab>
            <v-tab value="watchers">Watchers</v-tab>
            <v-tab value="notifications">Notifications</v-tab>
            <v-tab value="billing">Billing</v-tab>
          </v-tabs>
        </template>
      </v-app-bar>

      <v-main>
        <v-container max-width="800" class="py-6">
          <v-window v-model="activeTab">
            <!-- Inbox tab: eager so polling runs regardless of active tab -->
            <v-window-item value="inbox" eager>
              <GettingStarted
                v-if="showOnboarding"
                @go-watchers="activeTab = 'watchers'"
                @created="inbox.fetchActions()"
                @dismiss="showOnboarding = false"
              />
              <InboxList />
            </v-window-item>

            <v-window-item value="watchers">
              <WatchersScreen />
            </v-window-item>

            <v-window-item value="notifications">
              <NotificationsScreen />
            </v-window-item>

            <v-window-item value="billing">
              <BillingScreen />
            </v-window-item>
          </v-window>
        </v-container>
      </v-main>
    </template>

    <v-snackbar v-model="snackbar" :timeout="5000" :color="snackbarColor" location="top">
      {{ snackbarText }}
    </v-snackbar>
  </v-app>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useTheme } from 'vuetify'
import { useAuthStore } from './stores/auth'
import { useInboxStore } from './stores/inbox'
import LoginScreen from './components/LoginScreen.vue'
import InboxList from './components/InboxList.vue'
import WatchersScreen from './components/WatchersScreen.vue'
import NotificationsScreen from './components/NotificationsScreen.vue'
import BillingScreen from './components/BillingScreen.vue'
import GettingStarted from './components/GettingStarted.vue'

const auth = useAuthStore()
const inbox = useInboxStore()

const activeTab = ref<'inbox' | 'watchers' | 'notifications' | 'billing'>('inbox')
const pendingTotal = computed(() => inbox.pendingTotal)

// First-run onboarding (dismissible, re-openable via the app-bar help button).
const showOnboarding = ref(localStorage.getItem('impri-onboarding-dismissed') !== '1')
function openHelp(): void {
  activeTab.value = 'inbox'
  showOnboarding.value = true
}

const theme = useTheme()
const isDark = computed(() => theme.global.current.value.dark)
function toggleTheme() {
  const next = isDark.value ? 'light' : 'dark'
  theme.global.name.value = next
  localStorage.setItem('impri-theme', next)
}

// Return trip from Stripe Checkout / portal: land on the Billing tab and
// confirm the outcome, then clean the query so a refresh doesn't repeat it.
const snackbar = ref(false)
const snackbarText = ref('')
const snackbarColor = ref<'success' | 'info'>('success')

onMounted(() => {
  const checkout = new URLSearchParams(window.location.search).get('checkout')
  if (checkout === 'success') {
    activeTab.value = 'billing'
    snackbarColor.value = 'success'
    snackbarText.value = 'Subscription active — thanks! Your plan is now live.'
    snackbar.value = true
  } else if (checkout === 'canceled') {
    activeTab.value = 'billing'
    snackbarColor.value = 'info'
    snackbarText.value = 'Checkout canceled — no charge was made.'
    snackbar.value = true
  }
  if (checkout) {
    window.history.replaceState({}, '', window.location.pathname)
  }
})
</script>
