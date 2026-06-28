import { useEffect, useMemo, useRef, useState } from 'react'
import './MinimalShell.css'
import CompanyNewsPanel from '../../components/watchlist/CompanyNewsPanel'
import MarketNewsPanel from '../../components/watchlist/MarketNewsPanel'
import { useWatchlistStream } from '../../context/WatchlistStreamContext'
import { useNewsNotifications } from '../../hooks/useNewsNotifications'
import WatchAndTrade from './WatchAndTrade'
import { useUrlState } from './useUrlState'

/* ─── types ─────────────────────────────────────────────── */
type MainTab = 'home' | 'watch-trade' | 'orders' | 'strategies'
type NewsTab = 'news' | 'market'

const MAIN_TABS: MainTab[] = ['home', 'watch-trade', 'orders', 'strategies']
const NEWS_TABS: NewsTab[] = ['news', 'market']
const LEFT_COLLAPSED_KEY = 'minimal-shell-left-collapsed'
const RIGHT_COLLAPSED_KEY = 'minimal-shell-right-collapsed'
const RIGHT_WIDTH_KEY = 'minimal-shell-right-width'
const RIGHT_WIDTH_MIN = 220
const RIGHT_WIDTH_MAX = 560

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
}: {
  direction: 'left' | 'right'
  onClick: () => void
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="ms-collapse-btn"
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
function LeftDrawer({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  if (collapsed) {
    return (
      <aside className="ms-drawer ms-drawer--left ms-drawer--collapsed">
        <div className="ms-header ms-header--left ms-header--collapsed">
          <CollapseBtn direction="right" onClick={onToggle} label="Expand watchlist drawer" />
        </div>
        <div className="ms-body" />
      </aside>
    )
  }

  return (
    <aside className="ms-drawer ms-drawer--left">
      <div className="ms-header ms-header--left">
        <CollapseBtn direction="left" onClick={onToggle} label="Collapse watchlist drawer" />
        <Pill active wide>{'\u00a0Watchlist\u00a0'}</Pill>
      </div>
      <div className="ms-body" />
    </aside>
  )
}

function MainPanel({ tab, setTab }: { tab: MainTab; setTab: (t: MainTab) => void }) {
  return (
    <main className="ms-main">
      <div className="ms-header ms-header--main">
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
      <div className="ms-body" style={{ padding: 0, overflow: 'hidden' }}>
        {tab === 'watch-trade' ? (
          <WatchAndTrade />
        ) : (
          <div style={{ height: '100%', background: '#EBEBEB' }} />
        )}
      </div>
    </main>
  )
}

function RightDrawer({
  collapsed,
  onToggle,
  tab,
  setTab,
  search,
  setSearch,
  activeNewsSymbol,
  width,
  onResizeStart,
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
}) {
  if (collapsed) {
    return (
      <aside className="ms-drawer ms-drawer--right ms-drawer--collapsed">
        <div className="ms-header ms-header--right ms-header--collapsed">
          <CollapseBtn direction="left" onClick={onToggle} label="Expand right drawer" />
        </div>
        <div className="ms-body" />
      </aside>
    )
  }

  return (
    <aside className="ms-drawer ms-drawer--right" style={{ width, minWidth: width }}>
      <div
        className="ms-drawer-resize ms-drawer-resize--right"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize news panel"
        title="Drag left to widen news"
        onMouseDown={onResizeStart}
      />
      <div className="ms-header ms-header--right">
        <Pill active={tab === 'news'} onClick={() => setTab('news')}>
          {'\u00a0News\u00a0'}
        </Pill>
        <Pill active={tab === 'market'} onClick={() => setTab('market')}>
          {'\u00a0Market News\u00a0'}
        </Pill>
        <CollapseBtn direction="right" onClick={onToggle} label="Collapse right drawer" />
      </div>
      <SearchBar value={search} onChange={setSearch} />
      <div className="ms-body ms-body--scrollable">
        {tab === 'news' ? (
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
  const { watchlists } = useWatchlistStream()
  useNewsNotifications()
  const [leftCollapsed, setLeftCollapsed] = useState(() => loadStoredBool(LEFT_COLLAPSED_KEY))
  const [rightCollapsed, setRightCollapsed] = useState(() => loadStoredBool(RIGHT_COLLAPSED_KEY))
  const [rightWidth, setRightWidth] = useState(() =>
    loadStoredNumber(RIGHT_WIDTH_KEY, RIGHT_WIDTH_MIN, RIGHT_WIDTH_MIN, RIGHT_WIDTH_MAX),
  )
  const [search, setSearch] = useState('')
  const rightResizeRef = useRef<{ startX: number; startWidth: number } | null>(null)

  const mainTab: MainTab = MAIN_TABS.includes(state.tab as MainTab) ? (state.tab as MainTab) : 'orders'
  const newsTab: NewsTab = NEWS_TABS.includes(state.news as NewsTab) ? (state.news as NewsTab) : 'news'
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
  const setNewsTab = (t: NewsTab) => navigate({ news: t })
  const startRightResize = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    rightResizeRef.current = { startX: event.clientX, startWidth: rightWidth }
    document.body.classList.add('ms-resizing')

    const handleMove = (moveEvent: MouseEvent) => {
      const active = rightResizeRef.current
      if (!active) return
      const next = Math.min(
        RIGHT_WIDTH_MAX,
        Math.max(RIGHT_WIDTH_MIN, active.startWidth + active.startX - moveEvent.clientX),
      )
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
  const toggleLeftCollapsed = () => {
    setLeftCollapsed(prev => {
      const next = !prev
      localStorage.setItem(LEFT_COLLAPSED_KEY, String(next))
      return next
    })
  }
  const toggleRightCollapsed = () => {
    setRightCollapsed(prev => {
      const next = !prev
      localStorage.setItem(RIGHT_COLLAPSED_KEY, String(next))
      return next
    })
  }

  return (
    <div className="ms-root">
      <LeftDrawer collapsed={leftCollapsed} onToggle={toggleLeftCollapsed} />
      <MainPanel tab={mainTab} setTab={setMainTab} />
      <RightDrawer
        collapsed={rightCollapsed}
        onToggle={toggleRightCollapsed}
        tab={newsTab}
        setTab={setNewsTab}
        search={search}
        setSearch={setSearch}
        activeNewsSymbol={activeNewsSymbol}
        width={rightWidth}
        onResizeStart={startRightResize}
      />
    </div>
  )
}
