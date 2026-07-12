const SECOND_DURATION_KEYS = new Set([
  'usetime',
  'usedtime',
  'consumetime',
  'completiontime',
  'elapsedtime',
])

export function normalizeDurationValueMs(key: string, value: number) {
  const normalizedKey = key.toLowerCase()
  const compactKey = normalizedKey.replace(/[^a-z0-9]/g, '')
  const isMilliseconds = normalizedKey.includes('ms') || normalizedKey.includes('millisecond')
  const isSeconds = normalizedKey.includes('second') || SECOND_DURATION_KEYS.has(compactKey)
  const normalized = isMilliseconds ? value : isSeconds || value <= 30 ? value * 1000 : value
  return Math.max(0, Math.round(normalized))
}
