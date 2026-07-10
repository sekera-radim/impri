import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import './styles/app.css'
import App from './App.vue'

// Restore the user's last theme choice; default to dark.
const storedTheme = localStorage.getItem('impri-theme')
const defaultTheme = storedTheme === 'light' || storedTheme === 'dark' ? storedTheme : 'dark'

const vuetify = createVuetify({
  components,
  directives,
  icons: {
    defaultSet: 'mdi',
  },
  theme: {
    defaultTheme,
    themes: {
      dark: {
        dark: true,
        colors: {
          background: '#080c18',
          surface: '#12182c',
          primary: '#7c9cff',
          secondary: '#94a3b8',
          success: '#4ade80',
          warning: '#fbbf24',
          error: '#f87171',
          info: '#60a5fa',
        },
      },
      light: {
        dark: false,
        colors: {
          background: '#eef2fb',
          surface: '#ffffff',
          primary: '#4f46e5',
          secondary: '#5f6368',
          success: '#1e8e3e',
          warning: '#f9ab00',
          error: '#d93025',
          info: '#1a73e8',
        },
      },
    },
  },
})

const pinia = createPinia()
const app = createApp(App)

app.use(pinia)
app.use(vuetify)
app.mount('#app')
