import { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { useLocation } from 'react-router-dom'

import CompanyNewsPanel from '@/components/watchlist/CompanyNewsPanel'
import MarketNewsPanel from '@/components/watchlist/MarketNewsPanel'
import { useWatchlistStream } from '@/context/WatchlistStreamContext'
import { useWatchlistDock } from '@/layout/watchlist-dock-context'
import {
  WATCHLIST_CHART_LEGACY_PARAM,
  tickKeyFromRouteParams,
} from '@/lib/watchlistChartUrl'
import { tradingSymbolForTickKey } from '@/lib/watchlistSymbolLookup'

import MinimalDrawer from './MinimalDrawer'
import MinimalTabPills from './MinimalTabPills'

const STORAGE_KEY = 'minimal-ui-right-collapsed'

type NewsTab = 'news' | 'market'

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export default function RightNewsDrawer() {
  const location = useLocation()
  const { watchlists } = useWatchlistStream()
  const { newsSymbol, setNewsSymbol } = useWatchlistDock()
  const [collapsed, setCollapsed] = useState(loadCollapsed)
  const [tab, setTab] = useState<NewsTab>('news')
  const [search, setSearch] = useState('')

  const focusedTickKey = useMemo(() => {
    const match = location.pathname.match(/^\/watchlist\/chart\/([^/]+)\/([^/]+)\/([^/?]+)/)
    if (match) {
      return tickKeyFromRouteParams(match[1], match[2], match[3])
    }
    const params = new URLSearchParams(location.search)
    return params.get(WATCHLIST_CHART_LEGACY_PARAM)
  }, [location.pathname, location.search])

  const chartNewsSymbol = useMemo(() => {
    if (!focusedTickKey) return null
    return tradingSymbolForTickKey(focusedTickKey, watchlists)
  }, [focusedTickKey, watchlists])

  useEffect(() => {
    if (chartNewsSymbol) setNewsSymbol(chartNewsSymbol)
  }, [chartNewsSymbol, setNewsSymbol])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0')
    } catch {
      // ignore
    }
  }, [collapsed])

  const activeNewsSymbol = newsSymbol ?? chartNewsSymbol

  return (
    <MinimalDrawer
      side="right"
      headerClass="m-right-header"
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed(value => !value)}
      ariaLabel="News panel"
      widthClass="w-[260px]"
      header={
        <MinimalTabPills
          mode="state"
          tabs={[
            { id: 'news', label: 'News', active: tab === 'news', onClick: () => setTab('news') },
            {
              id: 'market',
              label: 'Market News',
              active: tab === 'market',
              onClick: () => setTab('market'),
            },
          ]}
        />
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        {tab === 'news' ? (
          <>
            <div className="shrink-0 p-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[rgb(var(--m-text-muted))]" />
                <input
                  type="search"
                  value={search}
                  onChange={event => setSearch(event.target.value)}
                  placeholder="Search headlines…"
                  className="h-8 w-full rounded-lg m-border m-search-bg pl-7 pr-2 text-[11px] text-[rgb(var(--m-text))] outline-none placeholder:text-[rgb(var(--m-text-muted))]"
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              {activeNewsSymbol ? (
                <CompanyNewsPanel
                  symbol={activeNewsSymbol}
                  variant="dock"
                  showHeader={false}
                  className="h-full bg-transparent"
                />
              ) : (
                <div className="flex h-full items-center justify-center p-4 text-center text-[11px] text-[rgb(var(--m-text-muted))]">
                  Open a watchlist chart or pick a symbol to load company news.
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="min-h-0 flex-1 overflow-hidden">
            <MarketNewsPanel className="h-full bg-transparent" />
          </div>
        )}
      </div>
    </MinimalDrawer>
  )
}
