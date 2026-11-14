/** Human-readable byte sizes for progress readouts. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—'
  }
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  // Whole numbers for bytes and KB; one decimal is noise at that scale.
  const digits = unit >= 2 ? 1 : 0
  return `${value.toFixed(digits)} ${units[unit]}`
}
