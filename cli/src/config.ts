import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// ─── Paths ────────────────────────────────────────────────────────────────────

export const CONFIG_DIR = path.join(os.homedir(), '.impri')
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

// ─── Shape ────────────────────────────────────────────────────────────────────

export interface ImpriConfig {
  base_url: string
  api_key: string
}

// ─── Load ─────────────────────────────────────────────────────────────────────

/**
 * Load config from ~/.impri/config.json.
 * Returns null when the file does not exist.
 * Throws on parse errors.
 * Never logs the key value.
 */
export function loadConfig(): ImpriConfig | null {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8')
    const parsed = JSON.parse(raw) as ImpriConfig
    return parsed
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return null
    }
    throw new Error(`Failed to read config at ${CONFIG_FILE}: ${(err as Error).message}`)
  }
}

// ─── Save ─────────────────────────────────────────────────────────────────────

/**
 * Write config to ~/.impri/config.json.
 * Directory created with 0700, file written with 0600.
 * Never logs the key value.
 */
export function saveConfig(config: ImpriConfig): void {
  // Create dir with restricted perms if missing.
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  } else {
    // Ensure dir perms are correct even if it already existed.
    try {
      fs.chmodSync(CONFIG_DIR, 0o700)
    } catch {
      // Non-fatal on systems where chmodSync may lack permission (Windows).
    }
  }

  const content = JSON.stringify(config, null, 2)
  fs.writeFileSync(CONFIG_FILE, content, { mode: 0o600, encoding: 'utf8' })

  // Ensure file perms even if file already existed (writeFileSync may not re-chmod).
  try {
    fs.chmodSync(CONFIG_FILE, 0o600)
  } catch {
    // Non-fatal on Windows.
  }
}

// ─── Resolve effective credentials ────────────────────────────────────────────

export interface ResolvedCredentials {
  apiKey: string
  baseUrl: string
  /** true when key came from env var rather than config file */
  keyFromEnv: boolean
}

/**
 * Resolve effective API key and base URL using precedence:
 *   1. IMPRI_API_KEY / IMPRI_BASE_URL env vars
 *   2. ~/.impri/config.json
 *   3. Default base URL (http://localhost:8484)
 *
 * Returns null for apiKey when neither env nor config supplies one.
 */
export function resolveCredentials(): { apiKey: string | null; baseUrl: string; keyFromEnv: boolean } {
  const envKey = process.env['IMPRI_API_KEY']
  const envUrl = process.env['IMPRI_BASE_URL']

  const config = loadConfig()

  const apiKey = envKey ?? config?.api_key ?? null
  const baseUrl = (envUrl ?? config?.base_url ?? 'http://localhost:8484').replace(/\/+$/, '')
  const keyFromEnv = !!envKey

  return { apiKey, baseUrl, keyFromEnv }
}

// ─── Key display helper ───────────────────────────────────────────────────────

/**
 * Redact an API key to its prefix for display.
 * Example: "im_abc123xyzlong" → "im_abc1****"
 * Never returns more than the first 8 chars of the key.
 */
export function redactKey(key: string): string {
  if (!key) return '****'
  const visible = Math.min(8, Math.floor(key.length / 3))
  return key.slice(0, visible) + '****'
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err
}
