/**
 * Returns the fill percentage (0–100) for a usage bar.
 * When limit is null (unlimited), returns 0 so no fill is shown.
 */
export function usagePercent(used: number, limit: number | null): number {
  if (limit === null || limit === 0) return 0
  return Math.min(100, Math.round((used / limit) * 100))
}

/**
 * Returns a Vuetify color name based on fill percentage.
 */
export function usageColor(percent: number): string {
  if (percent >= 90) return 'error'
  if (percent >= 70) return 'warning'
  return 'primary'
}
