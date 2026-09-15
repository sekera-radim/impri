import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createVuetify } from 'vuetify'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'
import 'vuetify/styles'
import '@mdi/font/css/materialdesignicons.css'
import './styles/app.css'
import App from './App.vue'
import { configureSentryReporting, reportError } from './utils/sentryReporting'

// Error reporting: no-op unless VITE_SENTRY_DSN is set at build time (unset
// for local dev and any deploy that hasn't opted in — see
// utils/sentryReporting.ts for the scrubbing that runs on every event).
configureSentryReporting({
  dsn: (import.meta.env.VITE_SENTRY_DSN as string | undefined) ?? '',
  environment: (import.meta.env.VITE_SENTRY_ENVIRONMENT as string | undefined) ?? (import.meta.env.PROD ? 'production' : 'development'),
  release: import.meta.env.VITE_SENTRY_RELEASE as string | undefined,
})

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

// Funnel every uncaught error through reportError() so scrubbing always runs
// (see utils/sentryReporting.ts) — no default Sentry global handlers, wired
// explicitly here instead.
app.config.errorHandler = (err, _instance, info) => {
  reportError(err, { source: 'vue', info })
  console.error(err)
}
window.addEventListener('error', (event) => {
  reportError(event.error ?? new Error(event.message), { source: 'window.onerror' })
})
window.addEventListener('unhandledrejection', (event) => {
  reportError(event.reason, { source: 'unhandledrejection' })
})

app.use(pinia)
app.use(vuetify)
app.mount('#app')
