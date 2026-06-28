import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './WatchAndTrade.css'
import { useWatchlistStream } from '../../context/WatchlistStreamContext'
import { formatBrokerMoney } from '../../lib/currency'
import {
  createWatchlist,
  updateWatchlist,
  deleteWatchlist,
  addWatchlistSymbol,
  removeWatchlistSymbol,
  watchlistTickKey,
  type Watchlist as BackendWatchlist,
  type WatchlistBroker,
  type WatchlistPanel as BackendPanel,
  type WatchlistSymbol,
} from '../../lib/watchlists'
import { fetchWatchlistPanels, createWatchlistPanel, updateWatchlistPanel, deleteWatchlistPanel } from '../../lib/watchlistPanelApi'
import {
  defaultAccountEnv,
  pickWatchlistSymbolMatch,
  searchWatchlistSymbol,
  type WatchlistSymbolHit,
} from '../../lib/watchlistBrokers'
import { formatWindowChangePct } from '../../lib/watchlistChangeColumns'
import { createAndStartMomentumStrategy } from '../../lib/watchlistMomentumStrategy'
import { DEFAULT_MOMENTUM_CONFIG, type MomentumConfig } from '../../lib/watchlistMomentum'
import { useUrlState } from './useUrlState'

/* ═══════════════════════════════════════════════════════════════
   Types
   ═══════════════════════════════════════════════════════════════ */
type Sym = {
  id: string; symboltoken: string; ticker: string; name: string; exchange: string; price: string
  c1m: string; c1mUp: boolean
  c5m: string; c5mUp: boolean
  chg: string; chgUp: boolean
  tickKey: string; ltp: number | null
}

type Watchlist = {
  id: string; name: string; broker: WatchlistBroker; accountEnv: string; symbols: Sym[]
}

/** Each panel owns two explicit column arrays — this is what makes cross-column DnD work. */
type Panel = {
  id: string; name: string
  cols: [Watchlist[], Watchlist[]]
}

type DragSrc = { col: 0|1; idx: number }
type DropTgt = { col: 0|1; idx: number; pos: 'before'|'after' } | { col: 0|1; idx: 'end' }

type SelectedSymbol = { watchlist: Watchlist; symbol: Sym }
type SearchHit = WatchlistSymbolHit & { name?: string; symbol?: string }

/* ─── per-stock momentum config (mirrors old WatchlistMomentumSettings) ─── */
type MomentumCfg = {
  // simple mode — the only fields that matter for a basic deploy
  tpPct: number          // take-profit %  (old longPercent)
  slPct: number          // stop-loss %    (old shortPercent)
  maxCapital: number
  min1mPct: number       // 1m profit threshold that arms the entry
  // complex mode
  min30sPct: number
  min5mPct: number
  min10mPct: number
  require10mPositive: boolean
  maxSpike1mPct: number
  max10mPct: number
  accelerationFactor: number
  require5mAbove10mRate: boolean
  minLtp: number
  maxLtp: number
  cooldownMin: number
  scanEverySec: number
  entryThreshold: number
}

const DEFAULT_MOMENTUM: MomentumCfg = {
  tpPct: 5, slPct: 1, maxCapital: 100_000, min1mPct: 0.75,
  min30sPct: 0.35, min5mPct: 1.0, min10mPct: 0.3, require10mPositive: false,
  maxSpike1mPct: 12, max10mPct: 8, accelerationFactor: 1.3, require5mAbove10mRate: false,
  minLtp: 0, maxLtp: 0, cooldownMin: 15, scanEverySec: 2, entryThreshold: 0.2,
}

const COLUMN_STORAGE_KEY = 'minimal-watch-trade-columns-v1'

function loadColumnMap(): Record<string, 0|1> {
  try {
    const raw = localStorage.getItem(COLUMN_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, number>
    const out: Record<string, 0|1> = {}
    for (const [key, value] of Object.entries(parsed)) {
      out[key] = value === 1 ? 1 : 0
    }
    return out
  } catch {
    return {}
  }
}

function saveColumnMap(map: Record<string, 0|1>) {
  localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(map))
}

function toMomentumConfig(cfg: MomentumCfg): MomentumConfig {
  return {
    ...DEFAULT_MOMENTUM_CONFIG,
    min30sPct: cfg.min30sPct,
    min1mPct: cfg.min1mPct,
    min5mPct: cfg.min5mPct,
    min10mPct: cfg.min10mPct,
    require10mPositive: cfg.require10mPositive,
    maxSpike1mPct: cfg.maxSpike1mPct,
    max10mPct: cfg.max10mPct,
    accelerationFactor: cfg.accelerationFactor,
    require5mAbove10mRate: cfg.require5mAbove10mRate,
    minLtp: cfg.minLtp,
    maxLtp: cfg.maxLtp,
    cooldownMs: Math.round(cfg.cooldownMin * 60_000),
    scanEveryMs: Math.max(500, Math.round(cfg.scanEverySec * 1000)),
    longPercent: cfg.tpPct,
    shortPercent: cfg.slPct,
    initialThreshold: cfg.entryThreshold,
    maxCapital: cfg.maxCapital,
  }
}

/* ═══════════════════════════════════════════════════════════════
   Panel tabs bar
   ═══════════════════════════════════════════════════════════════ */
function PanelTabs({ panels, activeId, onSelect, onAdd, onRename, onDelete }: {
  panels: Panel[]; activeId: string
  onSelect: (id: string) => void; onAdd: () => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
}) {
  const [editingId, setEditingId] = useState<string|null>(null)
  const [draft, setDraft] = useState('')
  const startEdit = (p: Panel) => { setEditingId(p.id); setDraft(p.name) }
  const finishEdit = (id: string) => {
    const next = draft.trim()
    setEditingId(null)
    if (next) onRename(id, next)
  }
  return (
    <div className="wt-panel-tabs-bar">
      <div className="wt-panel-tabs-scroll">
        {panels.map(p => {
          const active = p.id === activeId
          const editing = editingId === p.id
          const total = p.cols[0].length + p.cols[1].length
          return (
            <div key={p.id} className={`wt-panel-tab ${active ? 'wt-panel-tab--active':''}`}>
              {editing ? (
                <input autoFocus value={draft} onChange={e=>setDraft(e.target.value)}
                  onBlur={()=>finishEdit(p.id)}
                  onKeyDown={e=>{
                    if(e.key==='Enter')finishEdit(p.id)
                    if(e.key==='Escape')setEditingId(null)
                  }}
                  className="wt-tab-edit-input"/>
              ) : (
                <>
                  <button type="button" className="wt-tab-label"
                    onClick={()=>onSelect(p.id)} onDoubleClick={()=>startEdit(p)}>
                    {p.name}<span className="wt-tab-count">{total}</span>
                  </button>
                  <button type="button" className="wt-tab-edit-btn" onClick={()=>startEdit(p)}>✎</button>
                  <button type="button" className="wt-tab-delete-btn" onClick={()=>onDelete(p.id)}>×</button>
                </>
              )}
            </div>
          )
        })}
      </div>
      <button type="button" className="wt-add-panel-btn" onClick={onAdd}>+ Panel</button>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   Watchlist card
   ═══════════════════════════════════════════════════════════════ */
function WatchlistCard({ watchlist, selectedSymbolId, onSelectSymbol,
  isDragging, dropPos, onDragStart, onDragOver, onDrop, onDragEnd,
  onSearchSymbol, onAddSymbol, onRemoveSymbol, onBrokerChange, onDeleteWatchlist,
}: {
  watchlist: Watchlist; selectedSymbolId: string|null
  onSelectSymbol: (id: string) => void
  isDragging: boolean; dropPos: 'before'|'after'|null
  onDragStart: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
  onSearchSymbol: (wlId: string, query: string) => Promise<SearchHit[]>
  onAddSymbol: (wlId: string, hit: SearchHit) => Promise<void>
  onRemoveSymbol: (wlId: string, symboltoken: string) => void
  onBrokerChange: (wlId: string, broker: WatchlistBroker, accountEnv: string) => void
  onDeleteWatchlist: (wlId: string) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const openSearch = () => { setAdding(true); setQuery(''); setResults([]); setError(''); setTimeout(()=>inputRef.current?.focus(),0) }
  const closeSearch = () => { setAdding(false); setQuery(''); setResults([]); setError('') }
  const existing = new Set(watchlist.symbols.map(s=>s.symboltoken))
  const runSearch = async () => {
    setSearching(true)
    setError('')
    try {
      setResults(await onSearchSymbol(watchlist.id, query))
    } catch (err) {
      setResults([])
      setError(err instanceof Error ? err.message : 'Search failed')
    } finally {
      setSearching(false)
    }
  }

  return (
    <div
      className={[
        'wt-wl-card',
        isDragging ? 'wt-wl-card--dragging' : '',
        dropPos==='before' ? 'wt-wl-card--drop-before' : '',
        dropPos==='after'  ? 'wt-wl-card--drop-after'  : '',
      ].join(' ')}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <div className="wt-wl-header">
        <div className="wt-wl-header-left">
          <span className="wt-drag-handle">⠿</span>
          <button type="button" className="wt-collapse-btn" onClick={()=>setCollapsed(v=>!v)}>
            {collapsed ? '▶' : '▼'}
          </button>
          <span className="wt-wl-name">{watchlist.name}</span>
          <span className="wt-wl-count">{watchlist.symbols.length}</span>
        </div>
        <div className="wt-wl-header-right">
          {/* broker pill toggle */}
          <div className="wt-broker-toggle" onClick={e => e.stopPropagation()}>
            {(['etoro', 'angel'] as const).map(b => (
              <button
                key={b}
                type="button"
                className={`wt-broker-pill${watchlist.broker === b ? ' wt-broker-pill--active' : ''}`}
                onClick={() => onBrokerChange(watchlist.id, b, defaultAccountEnv(b))}
              >
                {b === 'etoro' ? 'eToro' : 'Angel'}
              </button>
            ))}
          </div>
          <button type="button" className="wt-add-symbol-btn" onClick={openSearch}>+ Add stock</button>
          <button type="button" className="wt-delete-chip" title="Delete watchlist" onClick={()=>onDeleteWatchlist(watchlist.id)}>×</button>
        </div>
      </div>

      {adding && (
        <div className="wt-add-stock-panel">
          <div className="wt-add-stock-row">
            <input ref={inputRef} value={query} onChange={e=>setQuery(e.target.value)}
              onKeyDown={e=>{ if(e.key==='Enter') void runSearch() }}
              placeholder="Search ticker or name…" className="wt-add-stock-input"/>
            <button type="button" className="wt-add-stock-search-btn"
              onClick={()=>void runSearch()}>{searching ? '...' : 'Search'}</button>
          </div>
          {results.length > 0 && (
            <div className="wt-add-stock-results">
              {results.map(r => {
                const already = existing.has(r.symboltoken)
                const label = r.tradingsymbol
                const name = r.name || r.symbol || r.exchange
                return (
                  <button key={r.symboltoken} type="button" disabled={already}
                    className={`wt-add-stock-result-row ${already?'wt-add-stock-result-row--disabled':''}`}
                    onClick={()=>{ if(!already){ void onAddSymbol(watchlist.id,r).then(closeSearch) } }}>
                    <span className="wt-add-result-ticker">{label}</span>
                    <span className="wt-add-result-name">{name}</span>
                    {already && <span className="wt-add-result-exists">added</span>}
                  </button>
                )
              })}
            </div>
          )}
          {error && <p className="wt-add-stock-no-results">{error}</p>}
          {results.length===0 && query && !searching && !error && <p className="wt-add-stock-no-results">No results for "{query}"</p>}
          <button type="button" className="wt-add-stock-cancel" onClick={closeSearch}>Cancel</button>
        </div>
      )}

      {!collapsed && (
        <table className="wt-sym-table">
          <colgroup>
            <col className="wt-col-sym"/>
            <col className="wt-col-c1m"/>
            <col className="wt-col-c5m"/>
            <col className="wt-col-chg"/>
            <col className="wt-col-price"/>
            <col className="wt-col-actions"/>
          </colgroup>
          <thead>
            <tr className="wt-sym-thead-row">
              <th className="wt-sym-th">Symbol</th>
              <th className="wt-sym-th wt-th-right">1m</th>
              <th className="wt-sym-th wt-th-right">5m</th>
              <th className="wt-sym-th wt-th-right">Chg%</th>
              <th className="wt-sym-th wt-th-right">Price</th>
              <th className="wt-sym-th wt-th-right"></th>
            </tr>
          </thead>
          <tbody>
            {watchlist.symbols.map(sym => (
              <tr key={sym.id}
                className={`wt-sym-row ${selectedSymbolId===sym.id?'wt-sym-row--selected':''}`}
                onClick={()=>onSelectSymbol(sym.id)}>
                <td className="wt-sym-td wt-sym-td--sym">
                  <span className="wt-sym-icon">{sym.ticker.charAt(0)}</span>
                  <div>
                    <div className="wt-sym-ticker">{sym.ticker}</div>
                    <div className="wt-sym-name-small">{sym.name}</div>
                  </div>
                </td>
                <td className={`wt-sym-td wt-td-num ${sym.c1mUp?'wt-up':'wt-down'}`}>{sym.c1m}</td>
                <td className={`wt-sym-td wt-td-num ${sym.c5mUp?'wt-up':'wt-down'}`}>{sym.c5m}</td>
                <td className={`wt-sym-td wt-td-num ${sym.chgUp?'wt-up':'wt-down'}`}>{sym.chg}</td>
                <td className="wt-sym-td wt-td-num wt-price-cell">{sym.price}</td>
                <td className="wt-sym-td wt-td-action">
                  <button
                    type="button"
                    className="wt-row-delete-btn"
                    title={`Remove ${sym.ticker}`}
                    onClick={e => {
                      e.stopPropagation()
                      onRemoveSymbol(watchlist.id, sym.symboltoken)
                    }}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   Watchlist column — one of the two side-by-side columns.
   Has its own drag-over / drop so empty space at the bottom
   of a column is a valid drop target.
   ═══════════════════════════════════════════════════════════════ */
function WatchlistColumn({ colIdx, watchlists, selectedSymbolId, onSelectSymbol,
  dragSrc, dropTgt,
  onDragStart, onCardDragOver, onCardDrop, onDragEnd,
  onColDragOver, onColDrop,
  onSearchSymbol, onAddSymbol, onRemoveSymbol, onBrokerChange, onDeleteWatchlist,
}: {
  colIdx: 0|1
  watchlists: Watchlist[]
  selectedSymbolId: string|null
  onSelectSymbol: (id: string) => void
  dragSrc: DragSrc|null
  dropTgt: DropTgt|null
  onDragStart: (col:0|1, idx:number) => void
  onCardDragOver: (e:React.DragEvent, col:0|1, idx:number) => void
  onCardDrop: (e:React.DragEvent) => void
  onDragEnd: () => void
  onColDragOver: (e:React.DragEvent, col:0|1) => void
  onColDrop: (e:React.DragEvent) => void
  onSearchSymbol: (wlId:string, query:string) => Promise<SearchHit[]>
  onAddSymbol: (wlId:string, hit:SearchHit) => Promise<void>
  onRemoveSymbol: (wlId:string, symboltoken:string) => void
  onBrokerChange: (wlId:string, broker:WatchlistBroker, accountEnv:string) => void
  onDeleteWatchlist: (wlId:string) => void
}) {
  return (
    <div
      className="wt-col-container"
      onDragOver={e => onColDragOver(e, colIdx)}
      onDrop={onColDrop}
    >
      {watchlists.map((wl, idx) => {
        const isDragging = dragSrc?.col === colIdx && dragSrc.idx === idx
        const isTarget = dropTgt && typeof dropTgt.idx === 'number' && dropTgt.col === colIdx && dropTgt.idx === idx
        const dropPos = isTarget ? (dropTgt as {pos:'before'|'after'}).pos : null
        return (
          <WatchlistCard
            key={wl.id}
            watchlist={wl}
            selectedSymbolId={selectedSymbolId}
            onSelectSymbol={onSelectSymbol}
            isDragging={isDragging}
            dropPos={dropPos}
            onDragStart={() => onDragStart(colIdx, idx)}
            onDragOver={e => onCardDragOver(e, colIdx, idx)}
            onDrop={onCardDrop}
            onDragEnd={onDragEnd}
            onSearchSymbol={onSearchSymbol}
            onAddSymbol={onAddSymbol}
            onRemoveSymbol={onRemoveSymbol}
            onBrokerChange={onBrokerChange}
            onDeleteWatchlist={onDeleteWatchlist}
          />
        )
      })}
      {/* "end" drop indicator shown when drop target is the end of this column */}
      {dropTgt?.col === colIdx && dropTgt.idx === 'end' && (
        <div className="wt-col-end-indicator" />
      )}
    </div>
  )
}

/* ─── small field helpers for the momentum form ─── */
function NumField({ label, value, step, min, unit, disabled, samples, sampleTone, onChange }: {
  label: string; value: number; step?: number; min?: number; unit?: string
  disabled?: boolean; samples?: number[]; sampleTone?: 'green'|'red'
  onChange: (v: number) => void
}) {
  return (
    <label className="wt-mf">
      <span className="wt-mf-label">{label}{unit ? <span className="wt-mf-unit"> {unit}</span> : null}</span>
      <input type="number" className="wt-mf-input" value={value} step={step ?? 1} min={min}
        disabled={disabled} onChange={e => onChange(Number(e.target.value))} />
      {samples && !disabled ? (
        <span className="wt-mf-samples">
          {samples.map(s => (
            <button key={s} type="button"
              className={`wt-mf-chip${value === s ? ' wt-mf-chip--on' : ''}${sampleTone ? ` wt-mf-chip--${sampleTone}` : ''}`}
              onClick={() => onChange(s)}>{s}</button>
          ))}
        </span>
      ) : null}
    </label>
  )
}

function CfgToggle({ label, checked, disabled, onChange }: {
  label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void
}) {
  return (
    <label className="wt-mt-row">
      <span className="wt-mt-label">{label}</span>
      <button type="button" disabled={disabled}
        className={`wt-mt-switch${checked ? ' wt-mt-switch--on' : ''}`}
        onClick={() => onChange(!checked)}>
        <span className="wt-mt-knob" />
      </button>
    </label>
  )
}

/* ─── per-stock momentum / quick-trade config ─── */
function MomentumPanel({ cfg, custom, onPatch, onToggleCustom, onReset, onDeploy }: {
  cfg: MomentumCfg; custom: boolean
  onPatch: (next: Partial<MomentumCfg>) => void
  onToggleCustom: (v: boolean) => void
  onReset: () => void
  onDeploy: (env: 'demo'|'live', cfg: MomentumCfg) => Promise<void>
}) {
  const [advanced, setAdvanced] = useState(false)
  const [env, setEnv] = useState<'demo'|'live'>('demo')
  const [deploying, setDeploying] = useState(false)
  const [message, setMessage] = useState('')
  const off = !custom

  const handleDeploy = async () => {
    setDeploying(true)
    setMessage('')
    try {
      await onDeploy(env, cfg)
      setMessage(`Started ${env} momentum strategy`)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Deploy failed')
    } finally {
      setDeploying(false)
    }
  }

  return (
    <div className="wt-mom">
      <div className="wt-mom-head">
        <span className="wt-mom-title">⚡ Quick Trade</span>
        {/* default vs custom config toggle */}
        <div className="wt-mode-toggle">
          <button type="button" className={`wt-mode-pill${!custom ? ' wt-mode-pill--active' : ''}`}
            onClick={() => onToggleCustom(false)}>Default</button>
          <button type="button" className={`wt-mode-pill${custom ? ' wt-mode-pill--active' : ''}`}
            onClick={() => onToggleCustom(true)}>Custom</button>
        </div>
      </div>

      {/* simple mode — minimal inputs */}
      <div className="wt-mom-grid">
        <NumField label="TP" unit="%" value={cfg.tpPct} step={0.5} min={0.1} disabled={off}
          samples={[3, 5, 10, 15]} sampleTone="green" onChange={v => onPatch({ tpPct: v })} />
        <NumField label="SL" unit="%" value={cfg.slPct} step={0.1} min={0.1} disabled={off}
          samples={[0.5, 1, 2, 3]} sampleTone="red" onChange={v => onPatch({ slPct: v })} />
        <NumField label="1m profit" unit="%" value={cfg.min1mPct} step={0.05} min={0} disabled={off}
          onChange={v => onPatch({ min1mPct: v })} />
        <NumField label="Max cap" value={cfg.maxCapital} step={1000} min={100} disabled={off}
          onChange={v => onPatch({ maxCapital: v })} />
      </div>

      {/* complex-mode expander */}
      <button type="button" className="wt-adv-toggle" onClick={() => setAdvanced(v => !v)}>
        <span>Advanced config</span>
        <span className={`wt-adv-caret${advanced ? ' wt-adv-caret--open' : ''}`}>▾</span>
      </button>
      {advanced ? (
        <div className="wt-adv-body">
          <div className="wt-adv-sec-title">Velocity</div>
          <div className="wt-mom-grid">
            <NumField label="Min 30s" unit="%" value={cfg.min30sPct} step={0.05} min={0} disabled={off}
              onChange={v => onPatch({ min30sPct: v })} />
            <NumField label="Min 5m" unit="%" value={cfg.min5mPct} step={0.05} min={0} disabled={off}
              onChange={v => onPatch({ min5mPct: v })} />
            <NumField label="Min 10m" unit="%" value={cfg.min10mPct} step={0.05} min={0} disabled={off}
              onChange={v => onPatch({ min10mPct: v })} />
            <NumField label="Entry thr." unit="%" value={cfg.entryThreshold} step={0.05} min={0} disabled={off}
              onChange={v => onPatch({ entryThreshold: v })} />
          </div>
          <CfgToggle label="Require 10m positive" checked={cfg.require10mPositive} disabled={off}
            onChange={v => onPatch({ require10mPositive: v })} />

          <div className="wt-adv-sec-title">Guards</div>
          <div className="wt-mom-grid">
            <NumField label="Max 1m spike" unit="%" value={cfg.maxSpike1mPct} step={0.5} min={1} disabled={off}
              onChange={v => onPatch({ maxSpike1mPct: v })} />
            <NumField label="Max 10m" unit="%" value={cfg.max10mPct} step={0.5} min={0} disabled={off}
              onChange={v => onPatch({ max10mPct: v })} />
          </div>

          <div className="wt-adv-sec-title">Acceleration</div>
          <div className="wt-mom-grid">
            <NumField label="1m accel ×" value={cfg.accelerationFactor} step={0.05} min={1} disabled={off}
              onChange={v => onPatch({ accelerationFactor: v })} />
          </div>
          <CfgToggle label="5m rate > 10m rate" checked={cfg.require5mAbove10mRate} disabled={off}
            onChange={v => onPatch({ require5mAbove10mRate: v })} />

          <div className="wt-adv-sec-title">Price filter (0 = off)</div>
          <div className="wt-mom-grid">
            <NumField label="Min LTP" value={cfg.minLtp} step={1} min={0} disabled={off}
              onChange={v => onPatch({ minLtp: v })} />
            <NumField label="Max LTP" value={cfg.maxLtp} step={1} min={0} disabled={off}
              onChange={v => onPatch({ maxLtp: v })} />
          </div>

          <div className="wt-adv-sec-title">Timing</div>
          <div className="wt-mom-grid">
            <NumField label="Cooldown" unit="min" value={cfg.cooldownMin} step={1} min={1} disabled={off}
              onChange={v => onPatch({ cooldownMin: v })} />
            <NumField label="Scan every" unit="s" value={cfg.scanEverySec} step={0.5} min={0.5} disabled={off}
              onChange={v => onPatch({ scanEverySec: v })} />
          </div>

          {custom ? (
            <button type="button" className="wt-reset-btn" onClick={onReset}>Reset to default</button>
          ) : null}
        </div>
      ) : null}

      {/* deploy */}
      <div className="wt-deploy-row">
        <div className="wt-env-toggle">
          <button type="button" className={`wt-env-pill${env==='demo'?' wt-env-pill--active':''}`}
            onClick={() => setEnv('demo')}>Demo</button>
          <button type="button" className={`wt-env-pill${env==='live'?' wt-env-pill--active wt-env-pill--live':''}`}
            onClick={() => setEnv('live')}>Live</button>
        </div>
        <button type="button" className="wt-deploy-btn" disabled={deploying} onClick={() => void handleDeploy()}>
          {deploying ? 'Deploying…' : '⚡ Deploy'}
        </button>
      </div>
      {message ? <div className="wt-deploy-message">{message}</div> : null}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   Detail panel (resizable)
   ═══════════════════════════════════════════════════════════════ */
function DetailPanel({ selected, width, onResizeStart }: {
  selected: SelectedSymbol|null; width: number; onResizeStart: (e:React.MouseEvent) => void
}) {
  const [chartHeight, setChartHeight] = useState(240)
  const chartResizingRef = useRef(false)
  // per-stock config map: each stock keeps its own override + custom flag
  const [configs, setConfigs] = useState<Record<string, MomentumCfg>>({})
  const [customMap, setCustomMap] = useState<Record<string, boolean>>({})

  const handleChartResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    chartResizingRef.current = true
    const startY = e.clientY; const startH = chartHeight
    const onMove = (ev: MouseEvent) => {
      if (!chartResizingRef.current) return
      setChartHeight(Math.max(60, Math.min(400, startH + (ev.clientY - startY))))
    }
    const onUp = () => {
      chartResizingRef.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const sym = selected?.symbol ?? null
  const symId = sym?.id ?? ''
  const cfg = configs[symId] ?? DEFAULT_MOMENTUM
  const custom = customMap[symId] ?? false
  const patchCfg = (next: Partial<MomentumCfg>) =>
    setConfigs(prev => ({ ...prev, [symId]: { ...(prev[symId] ?? DEFAULT_MOMENTUM), ...next } }))
  const toggleCustom = (v: boolean) => {
    setCustomMap(prev => ({ ...prev, [symId]: v }))
    // entering custom seeds the editable copy from the default
    if (v && !configs[symId]) setConfigs(prev => ({ ...prev, [symId]: { ...DEFAULT_MOMENTUM } }))
  }
  const resetCfg = () => setConfigs(prev => ({ ...prev, [symId]: { ...DEFAULT_MOMENTUM } }))
  const deploy = async (env: 'demo'|'live', nextCfg: MomentumCfg) => {
    if (!selected || selected.symbol.ltp == null) {
      throw new Error('No live price yet — try again in a moment')
    }
    await createAndStartMomentumStrategy(
      {
        broker: selected.watchlist.broker,
        tradingsymbol: selected.symbol.ticker,
        token: selected.symbol.symboltoken,
        exchange: selected.symbol.exchange,
        closePrice: selected.symbol.ltp,
        watchlistId: selected.watchlist.id,
        noTakeProfit: false,
      },
      env,
      toMomentumConfig(nextCfg),
    )
  }

  return (
    <div className="wt-detail-wrap" style={{ width }}>
      <div className="wt-resize-handle" onMouseDown={onResizeStart} title="Drag to resize" />
      {!sym ? (
        <div className="wt-detail wt-detail--empty">
          <span className="wt-detail-hint">Select a stock</span>
        </div>
      ) : (
        <div className="wt-detail">
          <div className="wt-detail-top-row">
            <div className="wt-detail-img-box">
              <span className="wt-detail-logo-letter">{sym.ticker.charAt(0)}</span>
            </div>
            <div className="wt-detail-price-card">
              <div className="wt-detail-ticker">{sym.ticker}</div>
              <div className="wt-detail-fullname">{sym.name}</div>
              <div className="wt-detail-price">{sym.price}</div>
              <div className={`wt-detail-change ${sym.chgUp?'wt-up':'wt-down'}`}>{sym.chg}</div>
            </div>
          </div>
          <div className="wt-detail-chart-box" style={{ height: chartHeight }}>
            <span className="wt-chart-label">small chart</span>
            <div className="wt-chart-resize-handle" onMouseDown={handleChartResizeStart} title="Drag to resize chart" />
          </div>
          <div className="wt-detail-trade-box">
            <MomentumPanel
              cfg={cfg}
              custom={custom}
              onPatch={patchCfg}
              onToggleCustom={toggleCustom}
              onReset={resetCfg}
              onDeploy={deploy}
            />
          </div>
        </div>
      )}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   Root
   ═══════════════════════════════════════════════════════════════ */
export default function WatchAndTrade() {
  const { state, navigate } = useUrlState()
  const {
    watchlists: backendWatchlists,
    setWatchlists,
    watchlistsReady,
    refreshWatchlists,
    ticks,
    windowChanges,
  } = useWatchlistStream()
  const [backendPanels, setBackendPanels] = useState<BackendPanel[]>([])
  const [panelsReady, setPanelsReady] = useState(false)
  const [error, setError] = useState('')
  const [columnMap, setColumnMap] = useState<Record<string, 0|1>>(() => loadColumnMap())
  const [dragSrc, setDragSrc] = useState<DragSrc|null>(null)
  const [dropTgt, setDropTgt] = useState<DropTgt|null>(null)
  const [detailWidth, setDetailWidth] = useState(380)
  const [detailHidden, setDetailHidden] = useState(false)
  const resizingRef = useRef(false)

  const loadPanels = useCallback(async () => {
    try {
      setError('')
      const next = await fetchWatchlistPanels()
      setBackendPanels(next)
      setPanelsReady(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load panels')
      setPanelsReady(true)
    }
  }, [])

  useEffect(() => {
    void loadPanels()
  }, [loadPanels])

  const patchWatchlist = (updated: BackendWatchlist) => {
    setWatchlists(prev => prev.map(wl => wl.id === updated.id ? updated : wl))
  }

  const toDisplaySymbol = useCallback((wl: BackendWatchlist, symbol: WatchlistSymbol): Sym => {
    const tickKey = watchlistTickKey(wl.broker, wl.account_env, symbol.symboltoken)
    const tick = ticks[tickKey]
    const changes = windowChanges[tickKey]
    const c1m = changes?.['1m']
    const c5m = changes?.['5m']
    const dayChange = tick?.change_pct
    const ticker = symbol.tradingsymbol || symbol.symbol
    const name = symbol.symbol || symbol.tradingsymbol
    return {
      id: `${wl.id}:${symbol.symboltoken}`,
      symboltoken: symbol.symboltoken,
      ticker,
      name,
      exchange: symbol.exchange,
      price: tick ? formatBrokerMoney(wl.broker, tick.ltp) : '—',
      c1m: formatWindowChangePct(c1m),
      c1mUp: (c1m ?? 0) >= 0,
      c5m: formatWindowChangePct(c5m),
      c5mUp: (c5m ?? 0) >= 0,
      chg: formatWindowChangePct(dayChange),
      chgUp: (dayChange ?? 0) >= 0,
      tickKey,
      ltp: tick?.ltp ?? null,
    }
  }, [ticks, windowChanges])

  const panels = useMemo<Panel[]>(() => {
    return backendPanels
      .slice()
      .sort((a, b) => a.position - b.position)
      .map(panel => {
        const cols: [Watchlist[], Watchlist[]] = [[], []]
        backendWatchlists
          .filter(wl => wl.panel_id === panel.id)
          .slice()
          .sort((a, b) => a.position - b.position)
          .forEach((wl, index) => {
            const col = columnMap[wl.id] ?? ((index % 2) as 0|1)
            cols[col].push({
              id: wl.id,
              name: wl.name,
              broker: wl.broker,
              accountEnv: wl.account_env,
              symbols: wl.symbols.map(symbol => toDisplaySymbol(wl, symbol)),
            })
          })
        return { id: panel.id, name: panel.name, cols }
      })
  }, [backendPanels, backendWatchlists, columnMap, toDisplaySymbol])

  const activePanel = panels.find(p => p.id === state.panel_id) ?? panels[0] ?? null
  const activePanelId = activePanel?.id ?? ''
  const allWatchlists = activePanel ? [...activePanel.cols[0], ...activePanel.cols[1]] : []
  const selectedWl = allWatchlists.find(w => w.id === state.watchlist_id)
  const selectedSym =
    selectedWl?.symbols.find(s => s.symboltoken === state.symboltoken) ??
    allWatchlists.flatMap(wl => wl.symbols).find(s => s.symboltoken === state.symboltoken) ??
    null
  const selectedWatchlist = selectedSym
    ? allWatchlists.find(wl => wl.symbols.some(sym => sym.symboltoken === selectedSym.symboltoken)) ?? null
    : null
  const selectedSymbolId = selectedSym?.id ?? null
  const selected = selectedSym && selectedWatchlist ? { watchlist: selectedWatchlist, symbol: selectedSym } : null

  useEffect(() => {
    if (!activePanel || state.panel_id) return
    navigate({ panel_id: activePanel.id, panel: '', watchlist: '', stock: '' }, { replace: true })
  }, [activePanel, navigate, state.panel_id])

  /* ── selection ── */
  const handleSelectSymbol = (id: string) => {
    const wl = allWatchlists.find(w => w.symbols.some(s => s.id === id))
    const sym = wl?.symbols.find(s => s.id === id)
    if (!wl || !sym || !activePanel) return
    if (selectedSymbolId === id) {
      setDetailHidden(prev => !prev)
      return
    }
    setDetailHidden(false)
    navigate({
      tab: 'watch-trade',
      panel_id: activePanel.id,
      watchlist_id: wl.id,
      symboltoken: sym.symboltoken,
      panel: '',
      watchlist: '',
      stock: '',
    })
  }

  /* ── panel actions ── */
  const handleSelectPanel = (id: string) => {
    navigate({ tab: 'watch-trade', panel_id: id, watchlist_id: '', symboltoken: '', panel: '', watchlist: '', stock: '' })
  }
  const handleAddPanel = async () => {
    try {
      setError('')
      const panel = await createWatchlistPanel(`Panel ${backendPanels.length + 1}`)
      setBackendPanels(prev => [...prev, panel])
      void refreshWatchlists()
      navigate({ tab: 'watch-trade', panel_id: panel.id, watchlist_id: '', symboltoken: '', panel: '', watchlist: '', stock: '' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create panel')
    }
  }
  const handleRenamePanel = async (id: string, name: string) => {
    try {
      const panel = await updateWatchlistPanel(id, { name })
      setBackendPanels(prev => prev.map(p => p.id === id ? panel : p))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename panel')
    }
  }
  const handleDeletePanel = async (id: string) => {
    const panel = backendPanels.find(p => p.id === id)
    if (!panel) return
    try {
      setError('')
      await deleteWatchlistPanel(id)
      const nextPanels = backendPanels.filter(p => p.id !== id)
      setBackendPanels(nextPanels)
      void refreshWatchlists()
      if (activePanelId === id) {
        navigate({ tab: 'watch-trade', panel_id: nextPanels[0]?.id ?? '', watchlist_id: '', symboltoken: '' })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete panel')
    }
  }

  /* ── add watchlist — goes to the shorter column ── */
  const handleAddWatchlist = async () => {
    if (!activePanel) return
    try {
      setError('')
      const [left, right] = activePanel.cols
      const targetCol: 0|1 = left.length <= right.length ? 0 : 1
      const created = await createWatchlist(`Watchlist ${left.length + right.length + 1}`, {
        broker: 'etoro',
        account_env: defaultAccountEnv('etoro'),
        panel_id: activePanel.id,
      })
      setWatchlists(prev => [...prev, created])
      const nextMap = { ...columnMap, [created.id]: targetCol }
      setColumnMap(nextMap)
      saveColumnMap(nextMap)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create watchlist')
    }
  }

  /* ── change broker/env for a watchlist ── */
  const handleBrokerChange = async (wlId: string, broker: WatchlistBroker, accountEnv: string) => {
    try {
      const updated = await updateWatchlist(wlId, { broker, account_env: accountEnv })
      patchWatchlist(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update broker')
    }
  }
  const handleDeleteWatchlist = async (wlId: string) => {
    const wl = backendWatchlists.find(w => w.id === wlId)
    if (!wl) return
    try {
      setError('')
      await deleteWatchlist(wlId)
      setWatchlists(prev => prev.filter(item => item.id !== wlId))
      const nextMap = { ...columnMap }
      delete nextMap[wlId]
      setColumnMap(nextMap)
      saveColumnMap(nextMap)
      if (state.watchlist_id === wlId) {
        navigate({ watchlist_id: '', symboltoken: '' })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete watchlist')
    }
  }

  const handleSearchSymbol = async (wlId: string, query: string): Promise<SearchHit[]> => {
    const wl = backendWatchlists.find(w => w.id === wlId)
    if (!wl) return []
    return searchWatchlistSymbol(wl.broker, query, wl.account_env) as Promise<SearchHit[]>
  }

  /* ── add symbol to watchlist ── */
  const handleAddSymbol = async (wlId: string, hit: SearchHit) => {
    try {
      const results = [hit]
      const picked = pickWatchlistSymbolMatch(results, hit.tradingsymbol) ?? hit
      const updated = await addWatchlistSymbol(wlId, {
        symboltoken: picked.symboltoken,
        tradingsymbol: picked.tradingsymbol,
        exchange: picked.exchange || 'NSE',
      })
      patchWatchlist(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add symbol')
    }
  }
  const handleRemoveSymbol = async (wlId: string, symboltoken: string) => {
    const wl = backendWatchlists.find(w => w.id === wlId)
    const sym = wl?.symbols.find(item => item.symboltoken === symboltoken)
    if (!wl || !sym) return
    try {
      setError('')
      const updated = await removeWatchlistSymbol(wlId, symboltoken)
      patchWatchlist(updated)
      if (state.watchlist_id === wlId && state.symboltoken === symboltoken) {
        navigate({ symboltoken: '' })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove symbol')
    }
  }

  /* ── drag handlers ── */
  const handleDragStart = (col: 0|1, idx: number) => setDragSrc({ col, idx })

  const handleCardDragOver = (e: React.DragEvent, col: 0|1, idx: number) => {
    e.preventDefault()
    e.stopPropagation()       // don't bubble to column div
    if (!dragSrc) return
    if (dragSrc.col === col && dragSrc.idx === idx) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const pos: 'before'|'after' = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    setDropTgt({ col, idx, pos })
  }

  const handleColDragOver = (e: React.DragEvent, col: 0|1) => {
    e.preventDefault()
    // Only fires when NOT over a card (cards call stopPropagation)
    setDropTgt({ col, idx: 'end' })
  }

  const handleDrop = (e: React.DragEvent) => {
    e.stopPropagation()
    if (!dragSrc || !dropTgt) { setDragSrc(null); setDropTgt(null); return }

    if (!activePanel) { setDragSrc(null); setDropTgt(null); return }
    const cols: [Watchlist[], Watchlist[]] = [[...activePanel.cols[0]], [...activePanel.cols[1]]]
    const [moved] = cols[dragSrc.col].splice(dragSrc.idx, 1)
    if (!moved) { setDragSrc(null); setDropTgt(null); return }

    if (dropTgt.idx === 'end') {
      cols[dropTgt.col].push(moved)
    } else {
      let insertAt = dropTgt.pos === 'after' ? dropTgt.idx + 1 : dropTgt.idx
      if (dragSrc.col === dropTgt.col && dragSrc.idx < insertAt) insertAt--
      cols[dropTgt.col].splice(Math.max(0, insertAt), 0, moved)
    }

    const nextMap = { ...columnMap }
    cols.forEach((col, colIdx) => {
      col.forEach(wl => { nextMap[wl.id] = colIdx as 0|1 })
    })
    setColumnMap(nextMap)
    saveColumnMap(nextMap)
    setDragSrc(null)
    setDropTgt(null)
  }

  const handleDragEnd = () => { setDragSrc(null); setDropTgt(null) }

  /* ── resize detail ── */
  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    resizingRef.current = true
    const startX = e.clientX; const startW = detailWidth
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return
      setDetailWidth(Math.max(180, Math.min(600, startW + (startX - ev.clientX))))
    }
    const onUp = () => {
      resizingRef.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const loading = !watchlistsReady || !panelsReady
  const hasAny = activePanel ? activePanel.cols[0].length + activePanel.cols[1].length > 0 : false

  return (
    <div className="wt-root">
      <PanelTabs
        panels={panels}
        activeId={activePanelId}
        onSelect={handleSelectPanel}
        onAdd={handleAddPanel}
        onRename={handleRenamePanel}
        onDelete={handleDeletePanel}
      />

      <div className="wt-body">
        <div className="wt-wl-grid-wrap">
          {error ? <div className="wt-status wt-status--error">{error}</div> : null}
          {loading ? (
            <div className="wt-empty-panel"><p>Loading watchlists…</p></div>
          ) : !activePanel ? (
            <div className="wt-empty-panel"><p>No panels found.</p></div>
          ) : !hasAny ? (
            <div className="wt-empty-panel">
              <p>No watchlists in this panel.</p>
              <button type="button" className="wt-add-symbol-btn wt-add-symbol-btn--large" onClick={handleAddWatchlist}>
                + New watchlist
              </button>
            </div>
          ) : (
            <>
              <div className="wt-two-col">
                {([0, 1] as const).map(ci => (
                  <WatchlistColumn
                    key={ci}
                    colIdx={ci}
                    watchlists={activePanel.cols[ci]}
                    selectedSymbolId={selectedSymbolId}
                    onSelectSymbol={handleSelectSymbol}
                    dragSrc={dragSrc}
                    dropTgt={dropTgt}
                    onDragStart={handleDragStart}
                    onCardDragOver={handleCardDragOver}
                    onCardDrop={handleDrop}
                    onDragEnd={handleDragEnd}
                    onColDragOver={handleColDragOver}
                    onColDrop={handleDrop}
                    onSearchSymbol={handleSearchSymbol}
                    onAddSymbol={handleAddSymbol}
                    onRemoveSymbol={handleRemoveSymbol}
                    onBrokerChange={handleBrokerChange}
                    onDeleteWatchlist={handleDeleteWatchlist}
                  />
                ))}
              </div>
              <button type="button" className="wt-new-wl-btn" onClick={handleAddWatchlist}>
                + New watchlist
              </button>
            </>
          )}
        </div>

        {detailHidden ? (
          <button
            type="button"
            className="wt-detail-reveal-btn"
            onClick={() => setDetailHidden(false)}
            title="Show stock detail"
          >
            ‹ Detail
          </button>
        ) : (
          <div className="wt-detail-shell">
            <button
              type="button"
              className="wt-detail-hide-btn"
              onClick={() => setDetailHidden(true)}
              title="Hide stock detail"
            >
              ›
            </button>
            <DetailPanel selected={selected} width={detailWidth} onResizeStart={handleResizeStart}/>
          </div>
        )}
      </div>
    </div>
  )
}
