import { useEffect, useMemo, useRef, useState } from 'react'
import './MinimalShell.css'
import CompanyNewsPanel from '../../components/watchlist/CompanyNewsPanel'
import MarketNewsPanel from '../../components/watchlist/MarketNewsPanel'
import { useWatchlistStream } from '../../context/WatchlistStreamContext'
import {
  useNewsNotifications,
  type NewsUpdateGroup,
} from '../../hooks/useNewsNotifications'
import { formatWindowChangePct } from '../../lib/watchlistChangeColumns'
import { formatBrokerMoney } from '../../lib/currency'
import { watchlistTickKey, type Watchlist } from '../../lib/watchlists'
import WatchAndTrade from './WatchAndTrade'
import Strategies from './Strategies'
import MarketClockBar from './MarketClockBar'
import { useUrlState } from './useUrlState'

/* ─── types ─────────────────────────────────────────────── */
type MainTab = 'home' | 'watch-trade' | 'orders' | 'strategies'
type NewsTab = 'watchlist' | 'new' | 'news' | 'market'

const MAIN_TABS: MainTab[] = ['home', 'watch-trade', 'orders', 'strategies']
const NEWS_TABS: NewsTab[] = ['watchlist', 'news', 'market', 'new']
const LEFT_COLLAPSED_KEY = 'minimal-shell-left-collapsed'
const RIGHT_WIDTH_KEY = 'minimal-shell-right-width'
const RIGHT_WIDTH_MIN = 260
const RIGHT_WIDTH_MAX = 620

function loadStoredBool(key: string, fallback = false) {
  try {
    const value = localStorage.getItem(key)
    if (value == null) return fallback
    return value === 'true'
  } catch {
    return fallback
  }
}

function loadStoredNumber(key: string, fallback: number, min: number, max: number) {
  try {
    const value = Number(localStorage.getItem(key))
    if (!Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, value))
  } catch {
    return fallback
  }
}

/* ─── small reusable pieces ─────────────────────────────── */
function CollapseBtn({
  direction,
  onClick,
  label,
  className,
}: {
  direction: 'left' | 'right'
  onClick: () => void
  label: string
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={className ? `ms-collapse-btn ${className}` : 'ms-collapse-btn'}
    >
      {direction === 'left' ? '‹' : '›'}
    </button>
  )
}

function Pill({
  active,
  onClick,
  children,
  wide,
}: {
  active: boolean
  onClick?: () => void
  children: React.ReactNode
  wide?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`ms-pill ${active ? 'ms-pill--active' : 'ms-pill--idle'} ${wide ? 'ms-pill--wide' : ''}`}
    >
      {children}
    </button>
  )
}

function SearchBar({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="ms-search-wrap">
      <span className="ms-search-icon" aria-hidden="true">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
          <circle cx="5.5" cy="5.5" r="4.5" stroke="#606060" strokeWidth="1.3" />
          <line x1="9.1" y1="9.1" x2="12" y2="12" stroke="#606060" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </span>
      <input
        type="search"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder=""
        className="ms-search-input"
      />
    </div>
  )
}

/* ─── panels ────────────────────────────────────────────── */
function MainPanel({ tab, setTab }: { tab: MainTab; setTab: (t: MainTab) => void }) {
  return (
    <main className="ms-main">
      <div className="ms-header ms-header--main">
        <div className="ms-header-tabs">
          <Pill active={tab === 'home'} onClick={() => setTab('home')}>
            {'\u00a0Home\u00a0'}
          </Pill>
          <Pill active={tab === 'watch-trade'} onClick={() => setTab('watch-trade')}>
            {'\u00a0Watch\u00a0&\u00a0Trade\u00a0'}
          </Pill>
          <Pill active={tab === 'orders'} onClick={() => setTab('orders')}>
            {'\u00a0Orders\u00a0'}
          </Pill>
          <Pill active={tab === 'strategies'} onClick={() => setTab('strategies')}>
            {'\u00a0Strategies\u00a0'}
          </Pill>
        </div>
        <MarketClockBar />
      </div>
      <div className="ms-body" style={{ padding: 0, overflow: 'hidden' }}>
        {tab === 'watch-trade' ? (
          <WatchAndTrade />
        ) : tab === 'strategies' ? (
          <Strategies />
        ) : (
          <div style={{ height: '100%', background: '#EBEBEB' }} />
        )}
      </div>
    </main>
  )
}

function WatchlistDrawerPanel({
  watchlists,
  ticks,
  windowChanges,
  filterText,
  onSelectSymbol,
}: {
  watchlists: Watchlist[]
  ticks: ReturnType<typeof useWatchlistStream>['ticks']
  windowChanges: ReturnType<typeof useWatchlistStream>['windowChanges']
  filterText: string
  onSelectSymbol: (watchlist: Watchlist, symboltoken: string) => void
}) {
  const rows = useMemo(() => {
    const seen = new Set<string>()
    const query = filterText.trim().toLowerCase()
    const next: Array<{
      key: string
      label: string
      watchlist: Watchlist
      symboltoken: string
      price: string
      c1m: string
      c1mUp: boolean
      c5m: string
      c5mUp: boolean
    }> = []

    for (const watchlist of watchlists) {
      for (const symbol of watchlist.symbols) {
        const label = symbol.tradingsymbol || symbol.symbol
        const dedupeKey = label.trim().toUpperCase()
        if (!dedupeKey || seen.has(dedupeKey)) continue
        seen.add(dedupeKey)

        if (
          query
          && !label.toLowerCase().includes(query)
          && !(symbol.symbol || '').toLowerCase().includes(query)
        ) {
          continue
        }

        const tickKey = watchlistTickKey(watchlist.broker, watchlist.account_env, symbol.symboltoken)
        const tick = ticks[tickKey]
        const changes = windowChanges[tickKey]
        const c1m = changes?.['1m']
        const c5m = changes?.['5m']

        next.push({
          key: dedupeKey,
          label,
          watchlist,
          symboltoken: symbol.symboltoken,
          price: tick ? formatBrokerMoney(watchlist.broker, tick.ltp) : '—',
          c1m: formatWindowChangePct(c1m),
          c1mUp: (c1m ?? 0) >= 0,
          c5m: formatWindowChangePct(c5m),
          c5mUp: (c5m ?? 0) >= 0,
        })
      }
    }

    return next.sort((a, b) => a.label.localeCompare(b.label))
  }, [watchlists, ticks, windowChanges, filterText])

  if (!watchlists.length) {
    return <div className="ms-news-empty">No watchlists yet.</div>
  }

  if (!rows.length) {
    return <div className="ms-news-empty">No matching symbols.</div>
  }

  return (
    <div className="ms-side-symbols">
      {rows.map(row => (
        <button
          type="button"
          className="ms-side-symbol"
          key={row.key}
          onClick={() => onSelectSymbol(row.watchlist, row.symboltoken)}
        >
          <span className="ms-side-symbol__name">{row.label}</span>
          <span className="ms-side-symbol__price">{row.price}</span>
          <span className={`ms-side-symbol__change ${row.c1mUp ? 'wt-up' : 'wt-down'}`}>
            {row.c1m}
          </span>
          <span className={`ms-side-symbol__change ${row.c5mUp ? 'wt-up' : 'wt-down'}`}>
            {row.c5m}
          </span>
        </button>
      ))}
    </div>
  )
}

function NewNewsPanel({ groups }: { groups: NewsUpdateGroup[] }) {
  const [closedTopics, setClosedTopics] = useState<Set<string>>(() => new Set())

  const toggleTopic = (topic: string) => {
    setClosedTopics(prev => {
      const next = new Set(prev)
      if (next.has(topic)) next.delete(topic)
      else next.add(topic)
      return next
    })
  }

  if (!groups.length) {
    return (
      <div className="ms-news-empty">
        No new watchlist news yet. Updates will appear here grouped by ticker.
      </div>
    )
  }

  return (
    <div className="ms-news-new-panel">
      <div className="ms-news-new-panel__header">
        <strong>News Updates</strong>
        <span>{groups.length} tickers</span>
      </div>
      <div className="ms-news-new-list">
        {groups.map(group => {
          const collapsed = closedTopics.has(group.topic)
          return (
          <section
            className={`ms-news-new-card ${collapsed ? 'ms-news-new-card--collapsed' : ''}`}
            key={group.topic}
          >
            <button
              type="button"
              className="ms-news-new-card__top"
              onClick={() => toggleTopic(group.topic)}
              aria-expanded={!collapsed}
            >
              <div>
                <h3>{group.topic}</h3>
                <p>+{group.count} news update{group.count === 1 ? '' : 's'}</p>
              </div>
              <span className="ms-news-new-card__chevron" aria-hidden="true">
                {collapsed ? '▸' : '▾'}
              </span>
            </button>
            {!collapsed ? (
            <ul className="ms-news-new-card__items">
              {group.items.map(item => (
                <li key={item.id}>
                  <a href={item.url || '#'} target="_blank" rel="noopener noreferrer">
                    <span>{item.headline}</span>
                    {item.source ? <em>{item.source}</em> : null}
                  </a>
                </li>
              ))}
            </ul>
            ) : null}
          </section>
          )
        })}
      </div>
    </div>
  )
}

function SideDrawer({
  collapsed,
  onToggle,
  tab,
  setTab,
  search,
  setSearch,
  activeNewsSymbol,
  width,
  onResizeStart,
  newsGroups,
  watchlists,
  ticks,
  windowChanges,
  onSelectWatchlistSymbol,
}: {
  collapsed: boolean
  onToggle: () => void
  tab: NewsTab
  setTab: (t: NewsTab) => void
  search: string
  setSearch: (v: string) => void
  activeNewsSymbol: string | null
  width: number
  onResizeStart: (event: React.MouseEvent<HTMLDivElement>) => void
  newsGroups: NewsUpdateGroup[]
  watchlists: Watchlist[]
  ticks: ReturnType<typeof useWatchlistStream>['ticks']
  windowChanges: ReturnType<typeof useWatchlistStream>['windowChanges']
  onSelectWatchlistSymbol: (watchlist: Watchlist, symboltoken: string) => void
}) {
  if (collapsed) {
    return (
      <button
        type="button"
        className="ms-news-drawer-tab ms-news-drawer-tab--left"
        onClick={onToggle}
        aria-label="Open side drawer"
        title="Open watchlist and news"
      >
        ›
      </button>
    )
  }

  return (
    <aside
      className="ms-drawer ms-drawer--left ms-drawer--left-overlay"
      style={{ width, minWidth: width }}
    >
      <div
        className="ms-drawer-resize ms-drawer-resize--left"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize side drawer"
        title="Drag right to widen drawer"
        onMouseDown={onResizeStart}
      />
      <div className="ms-header ms-header--left">
        <Pill active={tab === 'watchlist'} onClick={() => setTab('watchlist')}>
          {'\u00a0Watchlist\u00a0'}
        </Pill>
        <Pill active={tab === 'news'} onClick={() => setTab('news')}>
          {'\u00a0News\u00a0'}
        </Pill>
        <Pill active={tab === 'market'} onClick={() => setTab('market')}>
          {'\u00a0Market News\u00a0'}
        </Pill>
        <Pill active={tab === 'new'} onClick={() => setTab('new')}>
          {'\u00a0News Updates\u00a0'}
        </Pill>
      </div>
      <CollapseBtn
        direction="left"
        onClick={onToggle}
        label="Collapse side drawer"
        className="ms-drawer-collapse-edge"
      />
      <SearchBar value={search} onChange={setSearch} />
      <div className="ms-body ms-body--scrollable">
        {tab === 'watchlist' ? (
          <WatchlistDrawerPanel
            watchlists={watchlists}
            ticks={ticks}
            windowChanges={windowChanges}
            filterText={search}
            onSelectSymbol={onSelectWatchlistSymbol}
          />
        ) : tab === 'new' ? (
          <NewNewsPanel groups={newsGroups} />
        ) : tab === 'news' ? (
          activeNewsSymbol ? (
            <CompanyNewsPanel
              symbol={activeNewsSymbol}
              variant="minimal"
              filterText={search}
            />
          ) : (
            <div className="ms-news-empty">
              Select a stock in Watch & Trade to load company news.
            </div>
          )
        ) : (
          <MarketNewsPanel variant="minimal" filterText={search} />
        )}
      </div>
    </aside>
  )
}

/* ─── root shell ─────────────────────────────────────────── */
export default function MinimalShell() {
  const { state, navigate } = useUrlState()
  const { watchlists, ticks, windowChanges } = useWatchlistStream()
  const setNewsTab = (t: NewsTab) => navigate({ news: t })
  const { groups: newsGroups } = useNewsNotifications({
    onOpenUpdates: () => setNewsTab('new'),
  })
  const [rightCollapsed, setRightCollapsed] = useState(() => loadStoredBool(LEFT_COLLAPSED_KEY))
  const [rightWidth, setRightWidth] = useState(() =>
    loadStoredNumber(RIGHT_WIDTH_KEY, RIGHT_WIDTH_MIN, RIGHT_WIDTH_MIN, RIGHT_WIDTH_MAX),
  )
  const [search, setSearch] = useState('')
  const rightResizeRef = useRef<{ startX: number; startWidth: number } | null>(null)

  const mainTab: MainTab = MAIN_TABS.includes(state.tab as MainTab) ? (state.tab as MainTab) : 'orders'
  const newsTab: NewsTab = NEWS_TABS.includes(state.news as NewsTab) ? (state.news as NewsTab) : 'watchlist'
  const activeNewsSymbol = useMemo(() => {
    if (!state.symboltoken) return null
    for (const watchlist of watchlists) {
      const symbol = watchlist.symbols.find(item => item.symboltoken === state.symboltoken)
      if (symbol) return symbol.tradingsymbol || symbol.symbol || null
    }
    return null
  }, [state.symboltoken, watchlists])

  // Canonicalise the URL on first load so the active page is always reflected.
  useEffect(() => {
    if (!state.tab) navigate({ tab: mainTab }, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setMainTab = (t: MainTab) => navigate({ tab: t })
  const handleSelectWatchlistSymbol = (watchlist: Watchlist, symboltoken: string) => {
    navigate({
      tab: 'watch-trade',
      news: 'news',
      panel_id: watchlist.panel_id || undefined,
      watchlist_id: watchlist.id,
      symboltoken,
    })
  }
  const startRightResize = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    rightResizeRef.current = { startX: event.clientX, startWidth: rightWidth }
    document.body.classList.add('ms-resizing')

    const handleMove = (moveEvent: MouseEvent) => {
      const active = rightResizeRef.current
      if (!active) return
      const next = Math.min(RIGHT_WIDTH_MAX, Math.max(RIGHT_WIDTH_MIN, active.startWidth + moveEvent.clientX - active.startX))
      setRightWidth(next)
      localStorage.setItem(RIGHT_WIDTH_KEY, String(next))
    }

    const handleUp = () => {
      rightResizeRef.current = null
      document.body.classList.remove('ms-resizing')
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
  }
  const toggleRightCollapsed = () => {
    setRightCollapsed(prev => {
      const next = !prev
      localStorage.setItem(LEFT_COLLAPSED_KEY, String(next))
      return next
    })
  }

  return (
    <div className="ms-root">
      <MainPanel tab={mainTab} setTab={setMainTab} />
      <SideDrawer
        collapsed={rightCollapsed}
        onToggle={toggleRightCollapsed}
        tab={newsTab}
        setTab={setNewsTab}
        search={search}
        setSearch={setSearch}
        activeNewsSymbol={activeNewsSymbol}
        width={rightWidth}
        onResizeStart={startRightResize}
        newsGroups={newsGroups}
        watchlists={watchlists}
        ticks={ticks}
        windowChanges={windowChanges}
        onSelectWatchlistSymbol={handleSelectWatchlistSymbol}
      />
    </div>
  )
}
