export type WatchlistBroker = 'angel' | 'etoro'

export const WATCHLIST_BROKER_OPTIONS: { value: WatchlistBroker; label: string }[] = [
  { value: 'angel', label: 'Angel One' },
  { value: 'etoro', label: 'eToro' },
]

export function defaultAccountEnv(broker: WatchlistBroker): 'live' | 'demo' {
  return broker === 'etoro' ? 'demo' : 'live'
}

export async function searchWatchlistSymbol(
  broker: WatchlistBroker,
  query: string,
  accountEnv: string,
): Promise<Array<{ symboltoken: string; tradingsymbol: string; exchange: string }>> {
  const q = query.trim()
  if (!q) return []

  if (broker === 'etoro') {
    const params = new URLSearchParams({
      q,
      broker: 'etoro',
      exchange: 'ETORO',
      account_env: accountEnv,
    })
    const res = await fetch(`/api/control/search?${params}`)
    const body = await res.json()
    return body.status ? body.data || [] : []
  }

  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`)
  const body = await res.json()
  return body.status ? body.data || [] : []
}
