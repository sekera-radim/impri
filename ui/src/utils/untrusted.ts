/**
 * Returns true when the action payload explicitly signals external/untrusted
 * content (payload.untrusted === true).  Used to switch to plain-text rendering
 * and show a warning badge so the user knows the title/preview came from a
 * third-party source.
 */
export function isUntrustedPayload(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false
  return (payload as Record<string, unknown>).untrusted === true
}
