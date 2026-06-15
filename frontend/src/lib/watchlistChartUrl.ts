import { defaultAccountEnv, type WatchlistBroker } from './watchlistBrokers'
import { watchlistTickKey, type Watchlist } from './watchlists'

export const WATCHLIST_CHART_VIEW_PARAM = 'view'
export const WATCHLIST_CHART_PANEL_PARAM = 'panel'
export const WATCHLIST_CHART_LEGACY_PARAM = 'chart'

export function tickKeyFromRouteParams(
  broker?: string,
  accountEnv?: string,
  symbolToken?: string,
): string | null {
  if (!broker || !accountEnv || !symbolToken) return null
  return watchlistTickKey(
    broker,
    accountEnv,
    decodeURIComponent(symbolToken),
  )
}

export function buildWatchlistChartUrl(
  tickKey: string,
  panelId?: string | null,
): string {
  const [broker, accountEnv, token] = tickKey.split(':')
  if (!broker || !accountEnv || !token) {
    const params = new URLSearchParams({
      [WATCHLIST_CHART_VIEW_PARAM]: 'charts',
      [WATCHLIST_CHART_LEGACY_PARAM]: tickKey,
    })
    if (panelId) params.set(WATCHLIST_CHART_PANEL_PARAM, panelId)
    return `/watchlist?${params.toString()}`
  }

  const params = panelId ? `?${WATCHLIST_CHART_PANEL_PARAM}=${encodeURIComponent(panelId)}` : ''
  return `/watchlist/chart/${encodeURIComponent(broker)}/${encodeURIComponent(accountEnv)}/${encodeURIComponent(token)}${params}`
}

export function buildWatchlistChartsGridUrl(panelId?: string | null): string {
  const params = new URLSearchParams({ [WATCHLIST_CHART_VIEW_PARAM]: 'charts' })
  if (panelId) params.set(WATCHLIST_CHART_PANEL_PARAM, panelId)
  return `/watchlist?${params.toString()}`
}

export function findPanelIdForTickKey(
  watchlists: Watchlist[],
  tickKey: string,
  fallbackPanelId?: string | null,
): string | null {
  for (const wl of watchlists) {
    const broker = (wl.broker || 'angel') as WatchlistBroker
    const accountEnv = wl.account_env || defaultAccountEnv(broker)
    for (const sym of wl.symbols) {
      if (watchlistTickKey(broker, accountEnv, sym.symboltoken) === tickKey) {
        return wl.panel_id || fallbackPanelId || null
      }
    }
  }
  return fallbackPanelId ?? null
}

export async function copyWatchlistChartLink(url: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(url)
    return true
  } catch {
    return false
  }
}
