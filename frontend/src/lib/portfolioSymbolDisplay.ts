import type { PortfolioRow } from './portfolio-cache'
import { buildSymbolVisualMap, lookupSymbolVisual, type SymbolVisual } from './symbolVisuals'
import type { Watchlist, WatchlistSymbol } from './watchlists'

export type PortfolioSymbolDisplay = {
  ticker: string
  name: string | null
  visual: SymbolVisual | null
}

export type InstrumentDisplayRecord = {
  tradingsymbol?: string
  symbol?: string
  instrument_display_name?: string | null
  logo35x35?: string | null
  logo50x50?: string | null
  logo150x150?: string | null
}

function isNumericSymbol(value: string): boolean {
  return /^\d+$/.test(value.trim())
}

function cleanAngelTicker(value: string): string {
  return value.replace(/-EQ$/i, '')
}

export function portfolioInstrumentToken(row: PortfolioRow): string {
  const token = String(row.symboltoken || '').trim()
  if (token) return token
  const ticker = String(row.tradingsymbol || '').trim()
  return isNumericSymbol(ticker) ? ticker : ''
}

export function rowHasResolvedTicker(
  row: PortfolioRow,
  metadata?: InstrumentDisplayRecord,
): boolean {
  const candidates = [
    metadata?.tradingsymbol,
    metadata?.instrument_display_name,
    row.tradingsymbol,
    row.instrument_display_name,
    row.symbol,
  ]
  return candidates.some(value => {
    const text = String(value || '').trim()
    return Boolean(text) && !isNumericSymbol(text)
  })
}

export function buildPortfolioSymbolIndex(
  watchlists: Watchlist[],
  broker: string,
  accountEnv: string,
): Map<string, WatchlistSymbol> {
  const map = new Map<string, WatchlistSymbol>()
  const normalizedBroker = broker.toLowerCase()

  for (const watchlist of watchlists) {
    const wlBroker = (watchlist.broker || 'angel').toLowerCase()
    const wlEnv = watchlist.account_env || (wlBroker === 'etoro' ? 'demo' : 'live')
    if (wlBroker !== normalizedBroker) continue

    for (const symbol of watchlist.symbols) {
      const exactMatch = wlEnv === accountEnv
      const crossEnvFallback = normalizedBroker === 'etoro'
      if (!exactMatch && !crossEnvFallback) continue
      if (!exactMatch && map.has(symbol.symboltoken)) continue
      map.set(symbol.symboltoken, symbol)
    }
  }
  return map
}

function visualFromRecord(
  ticker: string,
  record: InstrumentDisplayRecord | WatchlistSymbol | PortfolioRow,
): SymbolVisual | null {
  const logos = {
    logo35x35: record.logo35x35 as string | null | undefined,
    logo50x50: record.logo50x50 as string | null | undefined,
    logo150x150: record.logo150x150 as string | null | undefined,
  }
  if (!logos.logo35x35 && !logos.logo50x50 && !logos.logo150x150) return null
  return { ticker, ...logos }
}

function pickTicker(
  ...values: Array<string | null | undefined>
): string {
  for (const value of values) {
    const text = String(value || '').trim()
    if (text && !isNumericSymbol(text)) return text
  }
  for (const value of values) {
    const text = String(value || '').trim()
    if (text) return text
  }
  return '—'
}

export function resolvePortfolioSymbolDisplay(
  row: PortfolioRow,
  watchlistIndex: Map<string, WatchlistSymbol>,
  visualMap: Map<string, SymbolVisual>,
  metadataByToken: Map<string, InstrumentDisplayRecord>,
): PortfolioSymbolDisplay {
  const token = portfolioInstrumentToken(row)
  const watchlistSym = token ? watchlistIndex.get(token) : undefined
  const metadata = token ? metadataByToken.get(token) : undefined
  const rowBroker = String(row.broker || 'angel').toLowerCase()

  if (watchlistSym) {
    const rawTicker = watchlistSym.tradingsymbol || watchlistSym.symbol || String(row.tradingsymbol || '')
    const tickerBase = rowBroker === 'angel' ? cleanAngelTicker(rawTicker) : rawTicker
    const ticker = pickTicker(
      metadata?.tradingsymbol,
      tickerBase,
      watchlistSym.instrument_display_name,
      watchlistSym.symbol,
    )
    const name =
      watchlistSym.instrument_display_name
      || watchlistSym.symbol
      || metadata?.instrument_display_name
      || (ticker !== rawTicker ? rawTicker : null)
    return {
      ticker,
      name: name && name !== ticker ? String(name) : null,
      visual:
        visualFromRecord(ticker, watchlistSym)
        || visualFromRecord(ticker, metadata || {})
        || lookupSymbolVisual(visualMap, ticker),
    }
  }

  const merged: InstrumentDisplayRecord = {
    tradingsymbol: String(row.tradingsymbol || ''),
    symbol: String(row.symbol || row.instrument_display_name || ''),
    instrument_display_name: String(row.instrument_display_name || row.symbol || ''),
    logo35x35: row.logo35x35 as string | null | undefined,
    logo50x50: row.logo50x50 as string | null | undefined,
    logo150x150: row.logo150x150 as string | null | undefined,
    ...metadata,
  }

  let ticker = pickTicker(
    merged.tradingsymbol,
    merged.instrument_display_name,
    merged.symbol,
    token,
  )
  if (rowBroker === 'angel') ticker = cleanAngelTicker(ticker)

  const nameValue = pickTicker(merged.instrument_display_name, merged.symbol)
  const name = nameValue && nameValue !== ticker ? nameValue : null
  return {
    ticker,
    name,
    visual:
      visualFromRecord(ticker, merged)
      || lookupSymbolVisual(visualMap, ticker)
      || lookupSymbolVisual(visualMap, String(row.tradingsymbol || '')),
  }
}

export function portfolioRowsNeedingDisplayLookup(
  rows: PortfolioRow[],
  watchlistIndex: Map<string, WatchlistSymbol>,
  metadataByToken: Map<string, InstrumentDisplayRecord>,
): string[] {
  const missing: string[] = []
  for (const row of rows) {
    const token = portfolioInstrumentToken(row)
    if (!token) continue
    if (watchlistIndex.has(token)) continue
    const metadata = metadataByToken.get(token)
    if (rowHasResolvedTicker(row, metadata) && visualFromRecord('', metadata || row)) continue
    if (rowHasResolvedTicker(row, metadata)) continue
    missing.push(token)
  }
  return [...new Set(missing)]
}

export async function fetchInstrumentDisplayMetadata(
  broker: string,
  accountEnv: string,
  instrumentIds: string[],
): Promise<Map<string, InstrumentDisplayRecord>> {
  const map = new Map<string, InstrumentDisplayRecord>()
  if (!instrumentIds.length) return map

  const params = new URLSearchParams({
    broker,
    account_env: accountEnv,
  })
  params.set('instrument_ids', instrumentIds.join(','))

  const res = await fetch(`/api/control/instruments/display?${params.toString()}`)
  const payload = await res.json() as {
    status?: boolean
    data?: Record<string, InstrumentDisplayRecord>
  }
  if (!res.ok || !payload.status || !payload.data) return map
  for (const [token, record] of Object.entries(payload.data)) {
    map.set(token, record)
  }
  return map
}

export async function hydratePortfolioSymbolMetadata(
  broker: string,
  accountEnv: string,
  rows: PortfolioRow[],
  watchlistIndex: Map<string, WatchlistSymbol>,
  existing: Map<string, InstrumentDisplayRecord> = new Map(),
): Promise<Map<string, InstrumentDisplayRecord>> {
  const missing = portfolioRowsNeedingDisplayLookup(rows, watchlistIndex, existing)
  if (!missing.length) return existing
  const fetched = await fetchInstrumentDisplayMetadata(broker, accountEnv, missing)
  if (!fetched.size) return existing
  const merged = new Map(existing)
  for (const [token, record] of fetched.entries()) merged.set(token, record)
  return merged
}

export function buildPortfolioVisualMap(watchlists: Watchlist[]): Map<string, SymbolVisual> {
  return buildSymbolVisualMap(watchlists)
}
