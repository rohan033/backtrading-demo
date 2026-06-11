/**
 * Client-side state for per-watchlist momentum trading preferences.
 * All data lives in localStorage — no backend changes needed.
 *
 *  - Which watchlists are "momentum trade" watchlists (only their first symbol is scanned)
 *  - Per-watchlist symbol order overrides (drag-to-reorder)
 *  - Archived symbols (removed after a momentum strategy is auto-deployed)
 */

const MOMENTUM_WL_IDS_KEY = 'wl-momentum-ids-v1'
const MOMENTUM_SYMBOL_KEYS_KEY = 'wl-momentum-symbols-v1'
const MOMENTUM_NOTP_SYMBOL_KEYS_KEY = 'wl-momentum-notp-symbols-v1'
const MOMENTUM_LIVE_SYMBOL_KEYS_KEY = 'wl-momentum-live-symbols-v1'
const SYMBOL_ORDER_KEY_PREFIX = 'wl-sym-order-'
const ARCHIVED_KEY = 'wl-momentum-archived-v1'

export const WL_MOMENTUM_CHANGED_EVENT = 'wl-momentum-changed'
export const WL_SYMBOL_ARCHIVED_EVENT = 'wl-symbol-archived'

export function notifyMomentumStateChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(WL_MOMENTUM_CHANGED_EVENT))
}

export function notifySymbolArchived(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(WL_SYMBOL_ARCHIVED_EVENT))
}

export function archivedSymbolKey(watchlistId: string, symboltoken: string): string {
  return `${watchlistId}::${symboltoken}`
}

export function loadArchivedSymbolKeys(): Set<string> {
  return new Set(
    loadArchivedSymbols().map(sym => archivedSymbolKey(sym.watchlistId, sym.symboltoken)),
  )
}

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

// ── Per-symbol momentum arming ────────────────────────────────────────────────
// Lets the user arm momentum on individual rows (not just the first row of a
// momentum watchlist). Keyed by `${watchlistId}::${symboltoken}`.

export function momentumSymbolKey(watchlistId: string, symboltoken: string): string {
  return `${watchlistId}::${symboltoken}`
}

export function loadMomentumSymbolKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(MOMENTUM_SYMBOL_KEYS_KEY)
    if (!raw) return new Set()
    return new Set(JSON.parse(raw) as string[])
  } catch {
    return new Set()
  }
}

export function saveMomentumSymbolKeys(keys: Set<string>): void {
  localStorage.setItem(MOMENTUM_SYMBOL_KEYS_KEY, JSON.stringify([...keys]))
}

/** Toggles momentum arming for one symbol and returns the new set. */
export function toggleMomentumSymbolKey(
  current: Set<string>,
  watchlistId: string,
  symboltoken: string,
): Set<string> {
  const key = momentumSymbolKey(watchlistId, symboltoken)
  const next = new Set(current)
  if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
  }
  saveMomentumSymbolKeys(next)
  return next
}

// ── No-take-profit momentum arming (let high-growth winners run) ───────────────

export function loadMomentumNoTpSymbolKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(MOMENTUM_NOTP_SYMBOL_KEYS_KEY)
    if (!raw) return new Set()
    return new Set(JSON.parse(raw) as string[])
  } catch {
    return new Set()
  }
}

export function saveMomentumNoTpSymbolKeys(keys: Set<string>): void {
  localStorage.setItem(MOMENTUM_NOTP_SYMBOL_KEYS_KEY, JSON.stringify([...keys]))
}

export type MomentumSymbolMode = 'normal' | 'no-tp'

/**
 * Toggles a symbol's momentum arming for the given mode. The two modes are
 * mutually exclusive — arming one clears the other. Returns both updated sets.
 */
export function setMomentumSymbolMode(
  normal: Set<string>,
  noTp: Set<string>,
  watchlistId: string,
  symboltoken: string,
  mode: MomentumSymbolMode,
): { normal: Set<string>; noTp: Set<string> } {
  const key = momentumSymbolKey(watchlistId, symboltoken)
  const nextNormal = new Set(normal)
  const nextNoTp = new Set(noTp)
  if (mode === 'normal') {
    if (nextNormal.has(key)) {
      nextNormal.delete(key)
    } else {
      nextNormal.add(key)
      nextNoTp.delete(key)
    }
  } else {
    if (nextNoTp.has(key)) {
      nextNoTp.delete(key)
    } else {
      nextNoTp.add(key)
      nextNormal.delete(key)
    }
  }
  saveMomentumSymbolKeys(nextNormal)
  saveMomentumNoTpSymbolKeys(nextNoTp)
  return { normal: nextNormal, noTp: nextNoTp }
}

// ── Per-symbol live/demo deploy target ────────────────────────────────────────
// Keys present in this set deploy momentum trades on live; absent keys use demo.

export function loadMomentumLiveSymbolKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(MOMENTUM_LIVE_SYMBOL_KEYS_KEY)
    if (!raw) return new Set()
    return new Set(JSON.parse(raw) as string[])
  } catch {
    return new Set()
  }
}

export function saveMomentumLiveSymbolKeys(keys: Set<string>): void {
  localStorage.setItem(MOMENTUM_LIVE_SYMBOL_KEYS_KEY, JSON.stringify([...keys]))
}

/** Toggles live deploy for one symbol and returns the new set. */
export function toggleMomentumLiveSymbolKey(
  current: Set<string>,
  watchlistId: string,
  symboltoken: string,
): Set<string> {
  const key = momentumSymbolKey(watchlistId, symboltoken)
  const next = new Set(current)
  if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
  }
  saveMomentumLiveSymbolKeys(next)
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
