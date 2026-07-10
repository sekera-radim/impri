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

      <v-main>
        <v-container max-width="800" class="py-6">
          <InboxList />
        </v-container>
      </v-main>
    </template>
  </v-app>
</template>

<script setup lang="ts">
import { useAuthStore } from './stores/auth'
import LoginScreen from './components/LoginScreen.vue'
import InboxList from './components/InboxList.vue'

const auth = useAuthStore()
</script>
