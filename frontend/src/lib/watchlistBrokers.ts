export type WatchlistBroker = 'angel' | 'etoro'

export const WATCHLIST_BROKER_OPTIONS: { value: WatchlistBroker; label: string }[] = [
  { value: 'angel', label: 'Angel One' },
  { value: 'etoro', label: 'eToro' },
]

export function defaultAccountEnv(broker: WatchlistBroker): 'live' | 'demo' {
  return broker === 'etoro' ? 'demo' : 'live'
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
 * Looks up a single eToro instrument by its numeric instrument ID and maps the
 * display metadata into a search hit. Returns `null` when the ID is unknown so
 * callers can fall back to (or merge with) the text search results.
 */
export async function lookupEtoroInstrumentById(
  instrumentId: string,
  accountEnv: string,
): Promise<WatchlistSymbolHit | null> {
  const id = instrumentId.trim()
  if (!/^\d+$/.test(id)) return null

  const params = new URLSearchParams({
    broker: 'etoro',
    account_env: accountEnv,
    instrument_ids: id,
  })
  let body: { status?: boolean; data?: Record<string, Record<string, unknown>> }
  try {
    const res = await fetch(`/api/control/instruments/display?${params}`)
    body = await res.json()
  } catch {
    return null
  }
  const record = body?.status ? body.data?.[id] : undefined
  if (!record) return null

  const str = (value: unknown): string | null => {
    if (value == null) return null
    const text = String(value).trim()
    return text || null
  }
  const tradingsymbol = str(record.tradingsymbol) || id
  const displayName = str(record.instrument_display_name) || str(record.symbol)
  return {
    symboltoken: id,
    tradingsymbol,
    exchange: 'ETORO',
    name: displayName || tradingsymbol,
    symbol: str(record.symbol) || displayName || tradingsymbol,
    internalAssetClassName: str(record.internal_asset_class_name),
    instrumentDisplayName: displayName,
    logo35x35: str(record.logo35x35),
    logo50x50: str(record.logo50x50),
    logo150x150: str(record.logo150x150),
    raw: record,
  }
}

export async function searchWatchlistSymbol(
  broker: WatchlistBroker,
  query: string,
  accountEnv: string,
): Promise<WatchlistSymbolHit[]> {
  const q = query.trim()
  if (!q) return []

  if (broker === 'etoro') {
    const params = new URLSearchParams({
      q,
      broker: 'etoro',
      exchange: 'ETORO',
      account_env: accountEnv,
    })
    let textHits: WatchlistSymbolHit[] = []
    try {
      const res = await fetch(`/api/control/search?${params}`)
      const body = await res.json()
      textHits = body.status ? body.data || [] : []
    } catch {
      textHits = []
    }

    // Allow searching directly by numeric eToro instrument ID — the text search
    // endpoint only matches ticker/name, so a bare ID would otherwise miss.
    // Runs even when the text search failed, so an ID always resolves.
    if (/^\d+$/.test(q) && !textHits.some(hit => String(hit.symboltoken) === q)) {
      const byId = await lookupEtoroInstrumentById(q, accountEnv)
      if (byId) return [byId, ...textHits]
    }
    return textHits
  }

  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`)
  const body = await res.json()
  return body.status ? body.data || [] : []
}

/**
 * Picks the best broker hit for a free-text ticker or numeric instrument ID.
 * Prefers an exact trading-symbol match, then instrument-token / ID match,
 * then the symbol whose root (before the `-EQ` style suffix) matches, and
 * otherwise falls back to the first result.
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
  const byToken = results.find(r => String(r.symboltoken).toUpperCase() === target)
  if (byToken) return byToken
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
