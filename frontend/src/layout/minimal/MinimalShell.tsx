import { useState } from 'react'
import './MinimalShell.css'

/* ─── types ─────────────────────────────────────────────── */
type MainTab = 'home' | 'watchlist' | 'strategies'
type NewsTab = 'news' | 'market'

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
}: {
  active: boolean
  onClick?: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`ms-pill ${active ? 'ms-pill--active' : 'ms-pill--idle'}`}
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

function NewsCard({ label }: { label: string }) {
  return <div className="ms-news-card">{label}</div>
}

/* ─── panels ────────────────────────────────────────────── */
function LeftDrawer({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  if (collapsed) {
    return (
      <aside className="ms-drawer ms-drawer--left ms-drawer--collapsed">
        <div className="ms-header ms-header--left ms-header--collapsed">
          <CollapseBtn direction="right" onClick={onToggle} label="Expand left drawer" />
        </div>
        <div className="ms-body" />
      </aside>
    )
  }

  return (
    <aside className="ms-drawer ms-drawer--left">
      <div className="ms-header ms-header--left">
        <CollapseBtn direction="left" onClick={onToggle} label="Collapse left drawer" />
        <Pill active>{'\u00a0Orders\u00a0'}</Pill>
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
        <Pill active={tab === 'watchlist'} onClick={() => setTab('watchlist')}>
          {'\u00a0Watchlist\u00a0'}
        </Pill>
        <Pill active={tab === 'strategies'} onClick={() => setTab('strategies')}>
          {'\u00a0Strategies\u00a0'}
        </Pill>
      </div>
      <div className="ms-body" />
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
}: {
  collapsed: boolean
  onToggle: () => void
  tab: NewsTab
  setTab: (t: NewsTab) => void
  search: string
  setSearch: (v: string) => void
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
    <aside className="ms-drawer ms-drawer--right">
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
        <NewsCard label="News-1" />
        <NewsCard label="News-1" />
      </div>
    </aside>
  )
}

/* ─── root shell ─────────────────────────────────────────── */
export default function MinimalShell() {
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const [mainTab, setMainTab] = useState<MainTab>('home')
  const [newsTab, setNewsTab] = useState<NewsTab>('news')
  const [search, setSearch] = useState('')

  return (
    <div className="ms-root">
      <LeftDrawer collapsed={leftCollapsed} onToggle={() => setLeftCollapsed(v => !v)} />
      <MainPanel tab={mainTab} setTab={setMainTab} />
      <RightDrawer
        collapsed={rightCollapsed}
        onToggle={() => setRightCollapsed(v => !v)}
        tab={newsTab}
        setTab={setNewsTab}
        search={search}
        setSearch={setSearch}
      />
    </div>
  )
}
