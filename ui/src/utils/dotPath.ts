/**
 * Builds the `edited` payload for POST /v1/actions/:id/decision.
 *
 * The API expects dot-path keys as-is (e.g. "preview.body"), not deeply nested objects.
 * Mirrors the server's fail-closed validation: throws if any key is not in the whitelist.
 */
export function buildEditedPayload(
  changes: Record<string, unknown>,
  editableWhitelist: string[],
): Record<string, unknown> {
  const invalid = Object.keys(changes).filter((k) => !editableWhitelist.includes(k))
  if (invalid.length > 0) {
    throw new Error(`Field(s) not in editable whitelist: ${invalid.join(', ')}`)
  }
  // Return a shallow copy to avoid mutating the caller's object
  return { ...changes }
}

/**
 * Extracts a value from a nested object by dot-path (e.g. "preview.body" → obj.preview.body).
 * Returns undefined if any segment of the path is missing.
 */
export function getByDotPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}
