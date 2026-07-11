<template>
  <v-dialog v-model="show" max-width="520" scrollable @keydown.esc="show = false">
    <v-card>
      <v-card-title class="d-flex align-center pa-4 pb-2">
        <v-icon size="20" class="mr-2">mdi-keyboard</v-icon>
        Keyboard shortcuts
        <v-spacer />
        <v-btn icon="mdi-close" variant="text" size="small" @click="show = false" />
      </v-card-title>
      <v-divider />
      <v-card-text class="pa-4">
        <div class="shortcut-grid">
          <template v-for="(group, gi) in shortcutGroups" :key="gi">
            <div class="shortcut-group-label text-caption text-medium-emphasis font-weight-medium mt-3 mb-1" style="grid-column: 1 / -1">
              {{ group.label }}
            </div>
            <template v-for="(sc, si) in group.shortcuts" :key="si">
              <div class="shortcut-key-col">
                <kbd v-for="(k, ki) in sc.keys" :key="ki" class="kbd">{{ k }}</kbd>
              </div>
              <div class="text-body-2">{{ sc.description }}</div>
            </template>
          </template>
        </div>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
const show = defineModel<boolean>({ default: false })

const shortcutGroups = [
  {
    label: 'Navigation',
    shortcuts: [
      { keys: ['j'], description: 'Focus next card' },
      { keys: ['k'], description: 'Focus previous card' },
      { keys: ['Enter', 'Space'], description: 'Open focused card detail' },
      { keys: ['/'], description: 'Focus search field' },
      { keys: ['Esc'], description: 'Close dialog / blur search / exit bulk' },
      { keys: ['?'], description: 'Open this help overlay' },
    ],
  },
  {
    label: 'Actions on focused card',
    shortcuts: [
      { keys: ['a'], description: 'Approve focused card' },
      { keys: ['r'], description: 'Reject focused card' },
      { keys: ['e'], description: 'Open detail in edit mode' },
      { keys: ['x'], description: 'Toggle selection (enter bulk mode)' },
    ],
  },
  {
    label: 'Bulk actions',
    shortcuts: [
      { keys: ['Shift', 'A'], description: 'Bulk-approve all selected' },
      { keys: ['Shift', 'R'], description: 'Bulk-reject all selected' },
    ],
  },
]
</script>

<style scoped>
.shortcut-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 16px;
  align-items: center;
}

.shortcut-group-label {
  padding-top: 4px;
}

.shortcut-key-col {
  display: flex;
  gap: 4px;
  align-items: center;
  flex-wrap: nowrap;
  white-space: nowrap;
}

.kbd {
  display: inline-block;
  padding: 2px 6px;
  font-family: 'Roboto Mono', monospace;
  font-size: 0.75rem;
  line-height: 1.4;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 4px;
  background: rgba(var(--v-theme-surface-variant), 0.5);
  color: rgb(var(--v-theme-on-surface));
}
</style>
