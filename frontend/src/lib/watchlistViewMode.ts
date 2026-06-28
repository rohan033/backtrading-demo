export type WatchlistViewMode = 'cards' | 'charts'

const VIEW_MODE_KEY = 'watchlist-view-mode-v1'

export function loadWatchlistViewMode(): WatchlistViewMode {
  try {
    const raw = localStorage.getItem(VIEW_MODE_KEY)
    return raw === 'charts' ? 'charts' : 'cards'
  } catch {
    return 'cards'
  }
}

export function saveWatchlistViewMode(mode: WatchlistViewMode): void {
  localStorage.setItem(VIEW_MODE_KEY, mode)
}

export type WatchlistChartRenderMode = 'line' | 'candle'

const CHART_RENDER_KEY = 'watchlist-chart-render-v1'

export function loadWatchlistChartRenderMode(): WatchlistChartRenderMode {
  try {
    return localStorage.getItem(CHART_RENDER_KEY) === 'candle' ? 'candle' : 'line'
  } catch {
    return 'line'
  }
}

export function saveWatchlistChartRenderMode(mode: WatchlistChartRenderMode): void {
  localStorage.setItem(CHART_RENDER_KEY, mode)
}
