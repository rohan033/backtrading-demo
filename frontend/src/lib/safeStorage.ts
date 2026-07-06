/** Keys that store large candle/monitor blobs — safe to drop when quota is tight. */
const HEAVY_KEY_PREFIXES = [
  'home-chart-history:v2:',
  'agent-client-monitor:',
]

/** List keys trimmed to max entries when making room. */
const TRIM_LIST_KEYS: Record<string, number> = {
  'wl-momentum-trades-v1': 40,
  'wl-momentum-archived-v1': 40,
}

/**
 * Free localStorage space by removing heavy caches and trimming long momentum logs.
 * Chart history is re-fetched on demand; momentum deploy prefs are tiny and kept.
 */
export function pruneLocalStorageForQuota(): void {
  if (typeof localStorage === 'undefined') return

  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key) keys.push(key)
  }

  for (const key of keys) {
    if (HEAVY_KEY_PREFIXES.some(prefix => key.startsWith(prefix))) {
      try {
        localStorage.removeItem(key)
      } catch {
        // ignore
      }
    }
  }

  for (const [key, maxItems] of Object.entries(TRIM_LIST_KEYS)) {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) continue
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > maxItems) {
        localStorage.setItem(key, JSON.stringify(parsed.slice(0, maxItems)))
      }
    } catch {
      try {
        localStorage.removeItem(key)
      } catch {
        // ignore
      }
    }
  }
}

/** localStorage.setItem that never throws — prunes heavy caches once, then retries. */
export function safeSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    pruneLocalStorageForQuota()
    try {
      localStorage.setItem(key, value)
      return true
    } catch {
      return false
    }
  }
}
