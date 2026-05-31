import type { LogLineCategory } from './logLineStyle'

export type LogLevelFilter = LogLineCategory | 'all'

export const LOG_LEVEL_FILTERS: Array<{ id: LogLevelFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'error', label: 'ERR' },
  { id: 'warn', label: 'WRN' },
  { id: 'connected', label: 'OK' },
  { id: 'buy', label: 'BUY' },
  { id: 'sell', label: 'SEL' },
  { id: 'trigger', label: 'TRG' },
  { id: 'ws', label: 'WS' },
  { id: 'tick', label: 'TCK' },
  { id: 'engine', label: 'ENG' },
  { id: 'control', label: 'CTL' },
  { id: 'info', label: 'LOG' },
]

export function fuzzyMatchLog(query: string, text: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true

  const haystack = text.toLowerCase()
  if (haystack.includes(needle)) return true

  let start = 0
  for (const char of needle) {
    const index = haystack.indexOf(char, start)
    if (index < 0) return false
    start = index + 1
  }
  return true
}

export function matchesLogLevelFilter(
  category: LogLineCategory,
  activeLevels: Set<LogLevelFilter>,
): boolean {
  if (!activeLevels.size || activeLevels.has('all')) return true
  return activeLevels.has(category)
}
