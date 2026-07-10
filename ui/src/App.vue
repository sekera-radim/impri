<template>
  <v-app>
    <!-- Login screen (not authenticated) -->
    <template v-if="!auth.isLoggedIn">
      <LoginScreen />
    </template>

    <!-- Main app (authenticated) -->
    <template v-else>
      <v-app-bar elevation="1" density="compact">
        <v-app-bar-title>
          <span class="font-weight-bold">Impri</span>
          <span class="text-medium-emphasis text-body-2 ml-2">Approval Inbox</span>
        </v-app-bar-title>

        <template #append>
          <v-btn
            variant="text"
            size="small"
            prepend-icon="mdi-logout"
            @click="auth.logout()"
          >
            Sign out
          </v-btn>
        </template>
      </v-app-bar>

      <!-- Tab navigation -->
      <v-tabs
        v-model="activeTab"
        density="compact"
        color="primary"
        class="border-b"
      >
        <v-tab value="inbox">
          Inbox
          <v-badge
            v-if="pendingCount > 0"
            :content="pendingCount"
            color="error"
            inline
            class="ml-1"
          />
        </v-tab>
        <v-tab value="watchers">Watchers</v-tab>
        <v-tab value="billing">Billing</v-tab>
      </v-tabs>

      <v-main>
        <v-container max-width="800" class="py-6">
          <v-window v-model="activeTab">
            <!-- Inbox tab: eager so polling runs regardless of active tab -->
            <v-window-item value="inbox" eager>
              <InboxList />
            </v-window-item>

            <v-window-item value="watchers">
              <WatchersScreen />
            </v-window-item>

            <v-window-item value="billing">
              <BillingScreen />
            </v-window-item>
          </v-window>
        </v-container>
      </v-main>
    </template>
  </v-app>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAuthStore } from './stores/auth'
import { useInboxStore } from './stores/inbox'
import LoginScreen from './components/LoginScreen.vue'
import InboxList from './components/InboxList.vue'
import WatchersScreen from './components/WatchersScreen.vue'
import BillingScreen from './components/BillingScreen.vue'

const auth = useAuthStore()
const inbox = useInboxStore()

const activeTab = ref<'inbox' | 'watchers' | 'billing'>('inbox')
const pendingCount = computed(() => inbox.pendingCount)
</script>
