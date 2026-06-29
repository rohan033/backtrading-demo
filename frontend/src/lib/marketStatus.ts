import { cachedMarketFetch } from './marketApiCache'

export type MarketStatusPayload = {
  exchange?: string
  holiday?: string | null
  isOpen?: boolean
  session?: 'pre-market' | 'regular' | 'post-market' | null
  timezone?: string
  t?: number
}

export type MarketStatusResponse = {
  status: boolean
  data: MarketStatusPayload
  meta?: {
    cached?: boolean
    ageSeconds?: number
  }
}

const TTL_MARKET_STATUS_MS = 30 * 60 * 1000

export function marketStatusLabel(payload: MarketStatusPayload | null | undefined): string {
  if (!payload) return 'Market status unavailable'
  if (payload.holiday) return `Holiday: ${payload.holiday}`
  if (payload.isOpen) {
    if (payload.session === 'pre-market') return 'Pre-market open'
    if (payload.session === 'post-market') return 'After-hours open'
    return 'Market open'
  }
  if (payload.session === 'pre-market') return 'Pre-market'
  if (payload.session === 'post-market') return 'After-hours'
  return 'Market closed'
}

export async function fetchMarketStatus(exchange = 'US', refresh = false): Promise<MarketStatusResponse> {
  const params = new URLSearchParams({ exchange })
  if (refresh) params.set('refresh', 'true')
  const key = `/api/market/market-status?${params.toString()}`

  return cachedMarketFetch(
    key,
    TTL_MARKET_STATUS_MS,
    async () => {
      const res = await fetch(`/api/market/market-status?${params.toString()}`)
      const data = await res.json().catch(() => ({}))
      if (res.status === 404) {
        throw new Error('Market status route missing — restart the control plane server')
      }
      if (!res.ok) {
        throw new Error(typeof data.detail === 'string' ? data.detail : 'Failed to load market status')
      }
      return data as MarketStatusResponse
    },
    { force: refresh, staleMaxAgeMs: TTL_MARKET_STATUS_MS * 10 },
  )
}
