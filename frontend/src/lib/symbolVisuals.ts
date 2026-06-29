import type { Watchlist } from './watchlists'

export type SymbolVisual = {
  ticker: string
  logo35x35?: string | null
  logo50x50?: string | null
  logo150x150?: string | null
}

export function symbolLookupKeys(symbol: string): string[] {
  const raw = symbol.trim().toUpperCase()
  if (!raw) return []
  const keys = new Set<string>([raw])
  keys.add(raw.replace(/\.US$/i, ''))
  if (raw.includes('.')) keys.add(raw.split('.')[0])
  return [...keys]
}

export function buildSymbolVisualMap(watchlists: Watchlist[]): Map<string, SymbolVisual> {
  const map = new Map<string, SymbolVisual>()
  for (const watchlist of watchlists) {
    for (const symbol of watchlist.symbols) {
      const ticker = symbol.tradingsymbol || symbol.symbol || ''
      const visual: SymbolVisual = {
        ticker: ticker || symbol.symbol,
        logo35x35: symbol.logo35x35,
        logo50x50: symbol.logo50x50,
        logo150x150: symbol.logo150x150,
      }
      for (const key of symbolLookupKeys(ticker || symbol.symbol)) {
        if (!map.has(key)) map.set(key, visual)
      }
    }
  }
  return map
}

export function lookupSymbolVisual(
  map: Map<string, SymbolVisual>,
  symbol: string,
): SymbolVisual | null {
  for (const key of symbolLookupKeys(symbol)) {
    const hit = map.get(key)
    if (hit) return hit
  }
  return null
}
