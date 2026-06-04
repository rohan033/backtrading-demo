export type WatchlistCardLayout = {
  x: number
  y: number
  width: number
}

export type WatchlistCardMetrics = {
  symbolCount: number
  searchOpen: boolean
}

export type WatchlistLayoutMap = Record<string, WatchlistCardLayout>

const STORAGE_KEY = 'watchlist-card-layouts-v3'

export const GRID_COLUMNS = 3
export const GRID_GAP_X = 20
export const GRID_GAP_Y = 20
export const GRID_ORIGIN_X = 20
export const GRID_ORIGIN_Y = 20

export const ROW_HEIGHT_PX = 38
export const TABLE_HEAD_PX = 36
export const CARD_TOOLBAR_PX = 48
/** Padding around the table panel (pt-2 + pb-2.5). */
export const CARD_TABLE_WRAP_PX = 20
export const CARD_CHROME_PX = 2
export const SEARCH_PANEL_PX = 96

/** Shared by header + body so columns line up. */
export const WATCHLIST_TABLE_GRID =
  'minmax(3.25rem,1fr) 5rem 2.75rem 4.75rem 1.75rem' as const
export const EMPTY_TABLE_PX = 56
export const DEFAULT_CARD_WIDTH = 340
export const MIN_CARD_WIDTH = 300
export const MAX_CARD_WIDTH = 400

/** Grid placement estimate for an empty watchlist. */
export const ESTIMATED_EMPTY_CARD_HEIGHT = cardHeightForContent(0, false)

export function tableBodyHeight(symbolCount: number): number {
  if (symbolCount <= 0) return EMPTY_TABLE_PX
  return symbolCount * ROW_HEIGHT_PX
}

export function cardHeightForContent(symbolCount: number, searchOpen = false): number {
  return (
    CARD_TOOLBAR_PX +
    CARD_TABLE_WRAP_PX +
    TABLE_HEAD_PX +
    tableBodyHeight(symbolCount) +
    CARD_CHROME_PX +
    (searchOpen ? SEARCH_PANEL_PX : 0)
  )
}

export function defaultLayout(index: number): WatchlistCardLayout {
  return layoutForGridSlot(index)
}

export function layoutForGridSlot(slot: number): WatchlistCardLayout {
  const col = slot % GRID_COLUMNS
  const row = Math.floor(slot / GRID_COLUMNS)
  return {
    x: GRID_ORIGIN_X + col * (DEFAULT_CARD_WIDTH + GRID_GAP_X),
    y: GRID_ORIGIN_Y + row * (ESTIMATED_EMPTY_CARD_HEIGHT + GRID_GAP_Y),
    width: DEFAULT_CARD_WIDTH,
  }
}

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  padding = 8,
): boolean {
  return !(
    a.x + a.w + padding <= b.x ||
    b.x + b.w + padding <= a.x ||
    a.y + a.h + padding <= b.y ||
    b.y + b.h + padding <= a.y
  )
}

function layoutRect(layout: WatchlistCardLayout, metrics: WatchlistCardMetrics) {
  return {
    x: layout.x,
    y: layout.y,
    w: layout.width,
    h: cardHeightForContent(metrics.symbolCount, metrics.searchOpen),
  }
}

export function layoutForNewWatchlist(
  existing: WatchlistLayoutMap,
  metricsById: Record<string, WatchlistCardMetrics>,
  excludeId?: string,
): WatchlistCardLayout {
  const occupied = Object.entries(existing)
    .filter(([id]) => id !== excludeId)
    .map(([id, layout]) =>
      layoutRect(normalizeLayout(layout), metricsById[id] ?? { symbolCount: 0, searchOpen: false }),
    )

  for (let slot = 0; slot < 48; slot++) {
    const candidate = layoutForGridSlot(slot)
    const rect = layoutRect(candidate, { symbolCount: 0, searchOpen: false })
    if (!occupied.some(other => rectsOverlap(rect, other))) {
      return candidate
    }
  }

  const maxY = occupied.reduce((m, r) => Math.max(m, r.y + r.h), GRID_ORIGIN_Y)
  return {
    ...layoutForGridSlot(0),
    y: maxY + GRID_GAP_Y,
  }
}

export function normalizeLayout(layout: WatchlistCardLayout & { bodyHeight?: number; visibleRows?: number }): WatchlistCardLayout {
  return {
    x: layout.x,
    y: layout.y,
    width: clampWidth(layout.width || DEFAULT_CARD_WIDTH),
  }
}

export function clampWidth(value: number): number {
  return Math.min(MAX_CARD_WIDTH, Math.max(MIN_CARD_WIDTH, Math.round(value)))
}

function migrateStoredLayouts(raw: Record<string, unknown>): WatchlistLayoutMap {
  const next: WatchlistLayoutMap = {}
  for (const [id, layout] of Object.entries(raw)) {
    if (!layout || typeof layout !== 'object') continue
    const row = layout as WatchlistCardLayout & { bodyHeight?: number }
    next[id] = normalizeLayout(row)
  }
  return next
}

export function loadWatchlistLayouts(): WatchlistLayoutMap {
  try {
    for (const key of [STORAGE_KEY, 'watchlist-card-layouts-v2', 'watchlist-card-layouts-v1']) {
      const raw = localStorage.getItem(key)
      if (!raw) continue
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (!parsed || typeof parsed !== 'object') continue
      const migrated = migrateStoredLayouts(parsed)
      if (key !== STORAGE_KEY) {
        saveWatchlistLayouts(migrated)
      }
      return migrated
    }
    return {}
  } catch {
    return {}
  }
}

export function saveWatchlistLayouts(layouts: WatchlistLayoutMap): void {
  const normalized: WatchlistLayoutMap = {}
  for (const [id, layout] of Object.entries(layouts)) {
    normalized[id] = normalizeLayout(layout)
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
}

export function mergeLayouts(
  watchlistIds: string[],
  existing: WatchlistLayoutMap,
): WatchlistLayoutMap {
  const next: WatchlistLayoutMap = {}
  watchlistIds.forEach((id, index) => {
    next[id] = normalizeLayout(existing[id] ?? layoutForGridSlot(index))
  })
  return next
}

export function canvasMinSize(
  layouts: WatchlistLayoutMap,
  metricsById: Record<string, WatchlistCardMetrics>,
): { width: number; height: number } {
  let maxX = 800
  let maxY = 600
  for (const [id, layout] of Object.entries(layouts)) {
    const rect = layoutRect(
      normalizeLayout(layout),
      metricsById[id] ?? { symbolCount: 0, searchOpen: false },
    )
    maxX = Math.max(maxX, rect.x + rect.w + GRID_GAP_X)
    maxY = Math.max(maxY, rect.y + rect.h + GRID_GAP_Y)
  }
  return { width: maxX, height: maxY }
}
