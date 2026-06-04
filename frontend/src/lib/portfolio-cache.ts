export type PortfolioRow = Record<string, unknown>

export type PortfolioResponse = {
  status: boolean
  data?: PortfolioRow[]
  message?: string
  cached?: boolean
  stale?: boolean
}

type CacheEntry = {
  data: PortfolioRow[]
  fetchedAt: number
}

const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<PortfolioResponse>>()

function cacheKey(broker: string, accountEnv: string) {
  return `${broker}:${accountEnv}`
}

export function readCachedPortfolio(broker: string, accountEnv: string): PortfolioRow[] | null {
  const entry = cache.get(cacheKey(broker, accountEnv))
  if (!entry) return null
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null
  return entry.data
}

export function getPortfolioFetchedAt(broker: string, accountEnv: string): number | null {
  const entry = cache.get(cacheKey(broker, accountEnv))
  return entry?.fetchedAt ?? null
}

export async function fetchPortfolio(
  broker: string,
  accountEnv: string,
  { refresh = false }: { refresh?: boolean } = {},
): Promise<PortfolioResponse> {
  const key = cacheKey(broker, accountEnv)
  const cached = cache.get(key)

  if (!refresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { status: true, data: cached.data, cached: true }
  }

  const pending = inflight.get(key)
  if (pending && !refresh) return pending

  const params = new URLSearchParams({
    broker,
    account_env: accountEnv,
  })
  if (refresh) params.set('refresh', 'true')

  const request = fetch(`/api/control/portfolio?${params.toString()}`)
    .then(async res => {
      const data = (await res.json()) as PortfolioResponse
      if (res.ok && data.status && Array.isArray(data.data)) {
        cache.set(key, { data: data.data, fetchedAt: Date.now() })
      }
      return data
    })
    .finally(() => {
      inflight.delete(key)
    })

  inflight.set(key, request)
  return request
}

export function primePortfolioCache(
  broker: string,
  accountEnv: string,
  rows: PortfolioRow[],
) {
  cache.set(cacheKey(broker, accountEnv), { data: rows, fetchedAt: Date.now() })
}
