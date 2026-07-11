/**
 * Build an ImpriClient from stored config + env vars,
 * with a friendly error when no key is available.
 */
import { ImpriClient } from '@impri/sdk'
import { resolveCredentials } from './config.js'
import { printError } from './output.js'

export function makeClient(opts?: { baseUrl?: string; apiKey?: string }): ImpriClient {
  const creds = resolveCredentials()

  const apiKey = opts?.apiKey ?? creds.apiKey
  const baseUrl = opts?.baseUrl ?? creds.baseUrl

  if (!apiKey) {
    printError("No API key configured. Run 'impri init' first, or set IMPRI_API_KEY.")
    process.exit(1)
  }

  return new ImpriClient({ apiKey, baseUrl })
}

/**
 * Like makeClient() but returns null instead of exiting when no key is set.
 * Used by `impri init` which constructs its own client mid-flow.
 */
export function makeClientOptional(opts?: {
  baseUrl?: string
  apiKey?: string
}): ImpriClient | null {
  const creds = resolveCredentials()
  const apiKey = opts?.apiKey ?? creds.apiKey
  const baseUrl = opts?.baseUrl ?? creds.baseUrl
  if (!apiKey) return null
  return new ImpriClient({ apiKey, baseUrl })
}
