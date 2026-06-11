/**
 * Client-side state for per-watchlist momentum trading preferences.
 * All data lives in localStorage — no backend changes needed.
 *
 *  - Which watchlists are "momentum trade" watchlists (only their first symbol is scanned)
 *  - Per-watchlist symbol order overrides (drag-to-reorder)
 *  - Archived symbols (removed after a momentum strategy is auto-deployed)
 */

const MOMENTUM_WL_IDS_KEY = 'wl-momentum-ids-v1'
const SYMBOL_ORDER_KEY_PREFIX = 'wl-sym-order-'
const ARCHIVED_KEY = 'wl-momentum-archived-v1'

// ── Momentum watchlist IDs ────────────────────────────────────────────────────

export function loadMomentumWatchlistIds(): Set<string> {
  try {
    const raw = localStorage.getItem(MOMENTUM_WL_IDS_KEY)
    if (!raw) return new Set()
    return new Set(JSON.parse(raw) as string[])
  } catch {
    return new Set()
  }
}

export function saveMomentumWatchlistIds(ids: Set<string>): void {
  localStorage.setItem(MOMENTUM_WL_IDS_KEY, JSON.stringify([...ids]))
}

/** Toggles the momentum-trade flag for a watchlist and returns the new set. */
export function toggleMomentumWatchlistId(current: Set<string>, id: string): Set<string> {
  const next = new Set(current)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  saveMomentumWatchlistIds(next)
  return next
}

// ── Symbol order overrides ────────────────────────────────────────────────────

export function loadSymbolOrder(watchlistId: string): string[] | null {
  try {
    const raw = localStorage.getItem(`${SYMBOL_ORDER_KEY_PREFIX}${watchlistId}`)
    return raw ? (JSON.parse(raw) as string[]) : null
  } catch {
    return null
  }
}

export function saveSymbolOrder(watchlistId: string, tokens: string[]): void {
  localStorage.setItem(`${SYMBOL_ORDER_KEY_PREFIX}${watchlistId}`, JSON.stringify(tokens))
}

export function clearSymbolOrder(watchlistId: string): void {
  localStorage.removeItem(`${SYMBOL_ORDER_KEY_PREFIX}${watchlistId}`)
}

/**
 * Returns symbols sorted by the stored order override.
 * Any newly-added symbols not yet in the override are appended at the end.
 */
export function applySymbolOrder<T extends { symboltoken: string }>(
  symbols: T[],
  order: string[] | null,
): T[] {
  if (!order || order.length === 0) return symbols
  const map = new Map(symbols.map(s => [s.symboltoken, s]))
  const sorted: T[] = []
  for (const token of order) {
    const sym = map.get(token)
    if (sym) sorted.push(sym)
  }
  // Append any symbols added since the order was saved
  for (const sym of symbols) {
    if (!sorted.includes(sym)) sorted.push(sym)
  }
  return sorted
}

// ── Archived momentum symbols ─────────────────────────────────────────────────

export type ArchivedMomentumSymbol = {
  watchlistId: string
  symboltoken: string
  tradingsymbol: string
  exchange: string
  broker: string
  executionId: string
  archivedAt: number
  entryPrice: number
}

export function loadArchivedSymbols(): ArchivedMomentumSymbol[] {
  try {
    const raw = localStorage.getItem(ARCHIVED_KEY)
    return raw ? (JSON.parse(raw) as ArchivedMomentumSymbol[]) : []
  } catch {
    return []
  }
}

/** Prepends the symbol to the archive list (capped at 200 entries) and returns the new list. */
export function archiveSymbol(sym: ArchivedMomentumSymbol): ArchivedMomentumSymbol[] {
  const existing = loadArchivedSymbols()
  const next = [sym, ...existing].slice(0, 200)
  localStorage.setItem(ARCHIVED_KEY, JSON.stringify(next))
  return next
}

export function removeArchivedSymbol(
  symboltoken: string,
  watchlistId: string,
): ArchivedMomentumSymbol[] {
  const existing = loadArchivedSymbols()
  const next = existing.filter(
    s => !(s.symboltoken === symboltoken && s.watchlistId === watchlistId),
  )
  localStorage.setItem(ARCHIVED_KEY, JSON.stringify(next))
  return next
}

export function clearArchivedSymbols(): ArchivedMomentumSymbol[] {
  localStorage.removeItem(ARCHIVED_KEY)
  return []
}
