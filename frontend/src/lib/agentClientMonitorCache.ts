export const CLIENT_MONITOR_WINDOW_MS = 10 * 60_000
/** Default batch interval — overridden per thread via monitor_interval_minutes metadata. */
export const CLIENT_MONITOR_FLUSH_MS = 10 * 60_000
export const CLIENT_MONITOR_CACHE_VERSION = 1
/** Keep monitor timer/markers across refresh for the active session. */
export const CLIENT_MONITOR_CACHE_TTL_MS = 6 * 60 * 60_000

export type ClientMonitorMarker = {
  id: string
  time: number
  symbol: string
  eventCount: number
}

export type ClientMonitorBatchRecord = {
  id: string
  at: number
  symbol: string
  eventCount: number
}

export type ClientMonitorCache = {
  version: number
  threadId: string
  expiresAt: number
  windowStartedAt: number
  lastFlushAt: number | null
  nextFlushAt: number
  markers: ClientMonitorMarker[]
  batches: ClientMonitorBatchRecord[]
}

function storageKey(threadId: string): string {
  return `agent-client-monitor:${threadId}`
}

export function loadClientMonitorCache(threadId: string): ClientMonitorCache | null {
  try {
    const raw = localStorage.getItem(storageKey(threadId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as ClientMonitorCache
    if (parsed.version !== CLIENT_MONITOR_CACHE_VERSION || parsed.threadId !== threadId) {
      return null
    }
    if (!Number.isFinite(parsed.expiresAt) || parsed.expiresAt <= Date.now()) {
      localStorage.removeItem(storageKey(threadId))
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function saveClientMonitorCache(cache: ClientMonitorCache): void {
  try {
    localStorage.setItem(storageKey(cache.threadId), JSON.stringify(cache))
  } catch {
    // ignore quota errors
  }
}

export function clearClientMonitorCache(threadId: string): void {
  try {
    localStorage.removeItem(storageKey(threadId))
  } catch {
    // ignore
  }
}

export function createClientMonitorCache(
  threadId: string,
  now = Date.now(),
  flushIntervalMs = CLIENT_MONITOR_FLUSH_MS,
): ClientMonitorCache {
  return {
    version: CLIENT_MONITOR_CACHE_VERSION,
    threadId,
    expiresAt: now + CLIENT_MONITOR_CACHE_TTL_MS,
    windowStartedAt: now,
    lastFlushAt: null,
    nextFlushAt: now + flushIntervalMs,
    markers: [],
    batches: [],
  }
}

export function resetClientMonitorWindow(
  threadId: string,
  now = Date.now(),
  flushIntervalMs = CLIENT_MONITOR_FLUSH_MS,
): ClientMonitorCache {
  const fresh = createClientMonitorCache(threadId, now, flushIntervalMs)
  saveClientMonitorCache(fresh)
  return fresh
}

export function touchClientMonitorCache(cache: ClientMonitorCache, now = Date.now()): ClientMonitorCache {
  const next = { ...cache, expiresAt: now + CLIENT_MONITOR_CACHE_TTL_MS }
  saveClientMonitorCache(next)
  return next
}

export function restoreOrCreateClientMonitorCache(
  threadId: string,
  now = Date.now(),
  flushIntervalMs = CLIENT_MONITOR_FLUSH_MS,
): ClientMonitorCache {
  const existing = loadClientMonitorCache(threadId)
  if (existing) return touchClientMonitorCache(existing, now)
  const created = createClientMonitorCache(threadId, now, flushIntervalMs)
  saveClientMonitorCache(created)
  return created
}

export function applyMonitorFlushInterval(
  cache: ClientMonitorCache,
  flushIntervalMs: number,
  now = Date.now(),
): ClientMonitorCache {
  const next: ClientMonitorCache = {
    ...cache,
    nextFlushAt: now + flushIntervalMs,
    expiresAt: now + CLIENT_MONITOR_CACHE_TTL_MS,
  }
  saveClientMonitorCache(next)
  return next
}

export function recordClientMonitorFlush(
  cache: ClientMonitorCache,
  marker: ClientMonitorMarker,
  batch: ClientMonitorBatchRecord,
  now = Date.now(),
  flushIntervalMs = CLIENT_MONITOR_FLUSH_MS,
): ClientMonitorCache {
  const next: ClientMonitorCache = {
    ...cache,
    expiresAt: now + CLIENT_MONITOR_CACHE_TTL_MS,
    windowStartedAt: now,
    lastFlushAt: now,
    nextFlushAt: now + flushIntervalMs,
    markers: [...cache.markers, marker].slice(-24),
    batches: [...cache.batches, batch].slice(-12),
  }
  saveClientMonitorCache(next)
  return next
}
