type CacheEntry<T> = {
  data: T
  fetchedAt: number
}

const memory = new Map<string, CacheEntry<unknown>>()
const inflight = new Map<string, Promise<unknown>>()

function readMemory<T>(key: string, ttlMs: number): T | null {
  const hit = memory.get(key) as CacheEntry<T> | undefined
  if (!hit) return null
  if (Date.now() - hit.fetchedAt > ttlMs) return null
  return hit.data
}

function readStaleMemory<T>(key: string): T | null {
  const hit = memory.get(key) as CacheEntry<T> | undefined
  return hit?.data ?? null
}

function writeMemory<T>(key: string, data: T): void {
  memory.set(key, { data, fetchedAt: Date.now() })
}

export type CachedFetchOptions = {
  force?: boolean
  /** On 429/5xx, return last good value if younger than this age. */
  staleMaxAgeMs?: number
}

/**
 * In-memory TTL cache with in-flight dedupe so StrictMode/HMR remounts do not
 * hammer Finnhub-backed routes.
 */
export async function cachedMarketFetch<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  options: CachedFetchOptions = {},
): Promise<T> {
  if (!options.force) {
    const fresh = readMemory<T>(key, ttlMs)
    if (fresh != null) return fresh
  }

  const pending = inflight.get(key) as Promise<T> | undefined
  if (pending) return pending

  const task = (async () => {
    try {
      const data = await fetcher()
      writeMemory(key, data)
      return data
    } catch (error) {
      const staleMaxAge = options.staleMaxAgeMs ?? ttlMs * 4
      const hit = memory.get(key) as CacheEntry<T> | undefined
      if (hit && Date.now() - hit.fetchedAt <= staleMaxAge) {
        return hit.data
      }
      throw error
    } finally {
      inflight.delete(key)
    }
  })()

  inflight.set(key, task)
  return task
}

export function peekMarketCache<T>(key: string, ttlMs: number): T | null {
  return readMemory<T>(key, ttlMs) ?? readStaleMemory<T>(key)
}
