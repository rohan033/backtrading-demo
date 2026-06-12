const STORAGE_KEY = 'wl-hidden-symbols-v1'

export const WL_HIDDEN_SYMBOLS_CHANGED_EVENT = 'wl-hidden-symbols-changed'

type HiddenMap = Record<string, string[]>

function loadMap(): HiddenMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as HiddenMap
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveMap(map: HiddenMap): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(WL_HIDDEN_SYMBOLS_CHANGED_EVENT))
  }
}

export function loadHiddenSymbolTokens(watchlistId: string): Set<string> {
  const map = loadMap()
  return new Set(map[watchlistId] ?? [])
}

export function loadAllHiddenSymbolTokens(): Record<string, Set<string>> {
  const map = loadMap()
  return Object.fromEntries(
    Object.entries(map).map(([watchlistId, tokens]) => [watchlistId, new Set(tokens)]),
  )
}

export function hideWatchlistSymbol(watchlistId: string, symboltoken: string): void {
  const map = loadMap()
  const current = new Set(map[watchlistId] ?? [])
  current.add(symboltoken)
  map[watchlistId] = [...current]
  saveMap(map)
}

export function unhideWatchlistSymbol(watchlistId: string, symboltoken: string): void {
  const map = loadMap()
  const current = new Set(map[watchlistId] ?? [])
  current.delete(symboltoken)
  if (current.size === 0) delete map[watchlistId]
  else map[watchlistId] = [...current]
  saveMap(map)
}

export function isWatchlistSymbolHidden(watchlistId: string, symboltoken: string): boolean {
  return loadHiddenSymbolTokens(watchlistId).has(symboltoken)
}

/** Filters symbols for UI display — hidden symbols stay subscribed on the feed. */
export function visibleWatchlistSymbols<T extends { symboltoken: string }>(
  symbols: T[],
  watchlistId: string,
  hidden?: Set<string>,
): T[] {
  const hiddenTokens = hidden ?? loadHiddenSymbolTokens(watchlistId)
  if (!hiddenTokens.size) return symbols
  return symbols.filter(symbol => !hiddenTokens.has(symbol.symboltoken))
}
