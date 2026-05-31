export type WatchlistCardLayout = {
  x: number
  y: number
  width: number
  /** Symbol list viewport height in pixels */
  bodyHeight: number
  /** Legacy v1 field — migrated to bodyHeight on load */
  visibleRows?: 2 | 3 | 4 | 5
}

export type WatchlistLayoutMap = Record<string, WatchlistCardLayout>

const STORAGE_KEY = 'watchlist-card-layouts-v2'

export const ROW_HEIGHT_PX = 28
export const CARD_HEADER_PX = 44
export const CARD_CHROME_PX = 12
export const MIN_BODY_HEIGHT = ROW_HEIGHT_PX * 2
export const MAX_BODY_HEIGHT = ROW_HEIGHT_PX * 12
export const MIN_CARD_WIDTH = 228
export const MAX_CARD_WIDTH = 360

export function defaultLayout(index: number): WatchlistCardLayout {
  return {
    x: 24 + (index % 4) * 220,
    y: 24 + Math.floor(index / 4) * 200,
    width: 228,
    bodyHeight: ROW_HEIGHT_PX * 4,
  }
}

export function normalizeLayout(layout: WatchlistCardLayout): WatchlistCardLayout {
  if (layout.bodyHeight && layout.bodyHeight >= MIN_BODY_HEIGHT) {
    return {
      ...layout,
      bodyHeight: clampBodyHeight(layout.bodyHeight),
      width: clampWidth(layout.width),
    }
  }
  const rows = layout.visibleRows ?? 4
  return {
    x: layout.x,
    y: layout.y,
    width: clampWidth(layout.width),
    bodyHeight: clampBodyHeight(rows * ROW_HEIGHT_PX),
  }
}

export function clampBodyHeight(value: number): number {
  return Math.min(MAX_BODY_HEIGHT, Math.max(MIN_BODY_HEIGHT, Math.round(value)))
}

export function clampWidth(value: number): number {
  return Math.min(MAX_CARD_WIDTH, Math.max(MIN_CARD_WIDTH, Math.round(value)))
}

export function cardTotalHeight(bodyHeight: number, adding = false): number {
  const searchExtra = adding ? 88 : 0
  return CARD_HEADER_PX + bodyHeight + CARD_CHROME_PX + searchExtra
}

export function loadWatchlistLayouts(): WatchlistLayoutMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      const legacy = localStorage.getItem('watchlist-card-layouts-v1')
      if (legacy) {
        const parsed = JSON.parse(legacy) as WatchlistLayoutMap
        const migrated: WatchlistLayoutMap = {}
        for (const [id, layout] of Object.entries(parsed)) {
          migrated[id] = normalizeLayout(layout as WatchlistCardLayout)
        }
        saveWatchlistLayouts(migrated)
        return migrated
      }
      return {}
    }
    const parsed = JSON.parse(raw) as WatchlistLayoutMap
    if (!parsed || typeof parsed !== 'object') return {}
    const next: WatchlistLayoutMap = {}
    for (const [id, layout] of Object.entries(parsed)) {
      next[id] = normalizeLayout(layout)
    }
    return next
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
    next[id] = normalizeLayout(existing[id] ?? defaultLayout(index))
  })
  return next
}
