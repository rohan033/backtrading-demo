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

export type WatchlistSymbolHit = {
  symboltoken: string
  tradingsymbol: string
  exchange: string
  name?: string
  symbol?: string
  internalAssetClassName?: string | null
  instrumentDisplayName?: string | null
  logo35x35?: string | null
  logo50x50?: string | null
  logo150x150?: string | null
  raw?: Record<string, unknown> | null
}

/**
 * Picks the best broker hit for a free-text ticker. Prefers an exact
 * trading-symbol match, then the symbol whose root (before the `-EQ` style
 * suffix) matches, and otherwise falls back to the first result.
 */
export function pickWatchlistSymbolMatch(
  results: WatchlistSymbolHit[],
  ticker: string,
): WatchlistSymbolHit | null {
  if (!results.length) return null
  const target = ticker.trim().toUpperCase()
  if (!target) return null
  const exact = results.find(r => r.tradingsymbol.toUpperCase() === target)
  if (exact) return exact
  const root = results.find(r => r.tradingsymbol.toUpperCase().split('-')[0] === target)
  if (root) return root
  return results[0]
}

/** Parses a comma/newline/whitespace separated ticker blob into a de-duped list. */
export function parseTickerInput(raw: string): string[] {
  const seen = new Set<string>()
  const tickers: string[] = []
  for (const token of raw.split(/[\s,;]+/)) {
    const ticker = token.trim().toUpperCase()
    if (!ticker || seen.has(ticker)) continue
    seen.add(ticker)
    tickers.push(ticker)
  }
  return tickers
}
