import { useEffect, useRef, useState } from 'react'
import './WatchAndTrade.css'
import { useUrlState } from './useUrlState'

/* ═══════════════════════════════════════════════════════════════
   Types
   ═══════════════════════════════════════════════════════════════ */
type Sym = {
  id: string; ticker: string; name: string; price: string
  c1m: string; c1mUp: boolean
  c5m: string; c5mUp: boolean
  chg: string; chgUp: boolean
}

type Watchlist = {
  id: string; name: string; broker: string; accountEnv: string; symbols: Sym[]
}

/** Each panel owns two explicit column arrays — this is what makes cross-column DnD work. */
type Panel = {
  id: string; name: string
  cols: [Watchlist[], Watchlist[]]
}

type DragSrc = { col: 0|1; idx: number }
type DropTgt = { col: 0|1; idx: number; pos: 'before'|'after' } | { col: 0|1; idx: 'end' }

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

/* ─── mock symbol search ─────────────────────────────────────── */
const MOCK_SYMS: { ticker: string; name: string }[] = [
  { ticker:'NVDA', name:'Nvidia' },   { ticker:'AMD',  name:'AMD' },
  { ticker:'INTC', name:'Intel' },    { ticker:'QCOM', name:'Qualcomm' },
  { ticker:'AAPL', name:'Apple' },    { ticker:'MSFT', name:'Microsoft' },
  { ticker:'GOOGL',name:'Alphabet' }, { ticker:'META', name:'Meta' },
  { ticker:'AMZN', name:'Amazon' },   { ticker:'NFLX', name:'Netflix' },
  { ticker:'TSLA', name:'Tesla' },    { ticker:'RIVN', name:'Rivian' },
  { ticker:'LCID', name:'Lucid' },    { ticker:'SQ',   name:'Block' },
  { ticker:'PYPL', name:'PayPal' },   { ticker:'HOOD', name:'Robinhood' },
  { ticker:'COIN', name:'Coinbase' }, { ticker:'BTC',  name:'Bitcoin' },
  { ticker:'ETH',  name:'Ethereum' }, { ticker:'SOL',  name:'Solana' },
  { ticker:'BNB',  name:'BNB' },      { ticker:'XRP',  name:'XRP' },
  { ticker:'SPY',  name:'S&P 500 ETF'},{ ticker:'QQQ', name:'Nasdaq ETF' },
  { ticker:'GLD',  name:'Gold ETF' }, { ticker:'PLTR', name:'Palantir' },
  { ticker:'ARM',  name:'Arm Holdings'},{ ticker:'SMCI',name:'Super Micro' },
]
const searchSymbols = (q: string) => {
  const u = q.trim().toUpperCase()
  return u ? MOCK_SYMS.filter(s => s.ticker.includes(u) || s.name.toUpperCase().includes(u)).slice(0, 8) : []
}
const makeStub = (ticker: string, name: string): Sym => {
  const up = Math.random() > 0.5
  const p = (n: number) => `${up ? '+' : '-'}${(Math.random() * n).toFixed(1)}%`
  return { id:`sym-${ticker}-${Date.now()}`, ticker, name,
           price:`$${(Math.random()*300+10).toFixed(2)}`,
           c1m:p(0.5), c1mUp:up, c5m:p(1), c5mUp:up, chg:p(2), chgUp:up }
}

/* ─── seed data ──────────────────────────────────────────────── */
const SEED: Panel[] = [
  {
    id:'p1', name:'US Equities',
    cols: [
      [
        { id:'wl-semis', name:'Semiconductors', broker:'eToro', accountEnv:'Live', symbols:[
          { id:'s1', ticker:'NVDA', name:'Nvidia',   price:'$138.85', c1m:'+0.3%',c1mUp:true,  c5m:'+0.8%',c5mUp:true,  chg:'+2.1%',chgUp:true  },
          { id:'s2', ticker:'AMD',  name:'AMD',       price:'$167.20', c1m:'-0.1%',c1mUp:false, c5m:'-0.3%',c5mUp:false, chg:'-0.4%',chgUp:false },
          { id:'s3', ticker:'INTC', name:'Intel',     price:'$21.45',  c1m:'+0.1%',c1mUp:true,  c5m:'+0.2%',c5mUp:true,  chg:'+0.7%',chgUp:true  },
          { id:'s4', ticker:'QCOM', name:'Qualcomm',  price:'$168.90', c1m:'+0.2%',c1mUp:true,  c5m:'+0.5%',c5mUp:true,  chg:'+1.1%',chgUp:true  },
        ]},
        { id:'wl-bigtech', name:'Big Tech', broker:'eToro', accountEnv:'Live', symbols:[
          { id:'s5', ticker:'AAPL',  name:'Apple',     price:'$211.42', c1m:'+0.2%',c1mUp:true,  c5m:'+0.6%',c5mUp:true,  chg:'+1.2%',chgUp:true  },
          { id:'s6', ticker:'MSFT',  name:'Microsoft', price:'$446.90', c1m:'+0.1%',c1mUp:true,  c5m:'+0.3%',c5mUp:true,  chg:'+0.5%',chgUp:true  },
          { id:'s7', ticker:'GOOGL', name:'Alphabet',  price:'$193.50', c1m:'+0.2%',c1mUp:true,  c5m:'+0.4%',c5mUp:true,  chg:'+0.9%',chgUp:true  },
          { id:'s8', ticker:'META',  name:'Meta',      price:'$620.15', c1m:'-0.1%',c1mUp:false, c5m:'-0.2%',c5mUp:false, chg:'-0.3%',chgUp:false },
        ]},
      ],
      [
        { id:'wl-ev', name:'EV & Mobility', broker:'eToro', accountEnv:'Demo', symbols:[
          { id:'s9',  ticker:'TSLA', name:'Tesla',  price:'$248.71', c1m:'-0.2%',c1mUp:false, c5m:'-0.5%',c5mUp:false, chg:'-0.8%',chgUp:false },
          { id:'s10', ticker:'RIVN', name:'Rivian', price:'$14.20',  c1m:'-0.3%',c1mUp:false, c5m:'-0.7%',c5mUp:false, chg:'-1.4%',chgUp:false },
          { id:'s11', ticker:'LCID', name:'Lucid',  price:'$2.85',   c1m:'+0.1%',c1mUp:true,  c5m:'+0.2%',c5mUp:true,  chg:'+0.4%',chgUp:true  },
        ]},
      ],
    ],
  },
  {
    id:'p2', name:'Fintech & Crypto',
    cols: [
      [
        { id:'wl-fintech', name:'Fintech', broker:'eToro', accountEnv:'Live', symbols:[
          { id:'s12', ticker:'SQ',   name:'Block',     price:'$73.40',  c1m:'+0.3%',c1mUp:true, c5m:'+0.7%',c5mUp:true, chg:'+1.6%',chgUp:true },
          { id:'s13', ticker:'PYPL', name:'PayPal',    price:'$68.15',  c1m:'+0.1%',c1mUp:true, c5m:'+0.1%',c5mUp:true, chg:'+0.2%',chgUp:true },
        ]},
      ],
      [
        { id:'wl-crypto', name:'Crypto Top 5', broker:'eToro', accountEnv:'Live', symbols:[
          { id:'s15', ticker:'BTC', name:'Bitcoin',  price:'$62,840', c1m:'+0.2%',c1mUp:true,  c5m:'+0.6%',c5mUp:true,  chg:'+1.4%',chgUp:true  },
          { id:'s16', ticker:'ETH', name:'Ethereum', price:'$3,410',  c1m:'+0.1%',c1mUp:true,  c5m:'+0.4%',c5mUp:true,  chg:'+0.8%',chgUp:true  },
          { id:'s17', ticker:'SOL', name:'Solana',   price:'$148.60', c1m:'-0.2%',c1mUp:false, c5m:'-0.4%',c5mUp:false, chg:'-0.9%',chgUp:false },
        ]},
      ],
    ],
  },
  {
    id:'p3', name:'Macro',
    cols: [
      [
        { id:'wl-idx', name:'Indices', broker:'eToro', accountEnv:'Live', symbols:[
          { id:'s20', ticker:'SPY', name:'S&P 500', price:'$524.30', c1m:'+0.1%',c1mUp:true, c5m:'+0.3%',c5mUp:true, chg:'+0.6%',chgUp:true },
          { id:'s21', ticker:'QQQ', name:'Nasdaq',  price:'$447.80', c1m:'+0.2%',c1mUp:true, c5m:'+0.4%',c5mUp:true, chg:'+0.9%',chgUp:true },
        ]},
      ],
      [],
    ],
  },
]

/* ═══════════════════════════════════════════════════════════════
   Panel tabs bar
   ═══════════════════════════════════════════════════════════════ */
function PanelTabs({ panels, activeId, onSelect, onAdd }: {
  panels: Panel[]; activeId: string
  onSelect: (id: string) => void; onAdd: () => void
}) {
  const [editingId, setEditingId] = useState<string|null>(null)
  const [draft, setDraft] = useState('')
  const startEdit = (p: Panel) => { setEditingId(p.id); setDraft(p.name) }
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
                  onBlur={()=>setEditingId(null)}
                  onKeyDown={e=>{if(e.key==='Enter'||e.key==='Escape')setEditingId(null)}}
                  className="wt-tab-edit-input"/>
              ) : (
                <>
                  <button type="button" className="wt-tab-label"
                    onClick={()=>onSelect(p.id)} onDoubleClick={()=>startEdit(p)}>
                    {p.name}<span className="wt-tab-count">{total}</span>
                  </button>
                  <button type="button" className="wt-tab-edit-btn" onClick={()=>startEdit(p)}>✎</button>
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
  onAddSymbol, onBrokerChange,
}: {
  watchlist: Watchlist; selectedSymbolId: string|null
  onSelectSymbol: (id: string) => void
  isDragging: boolean; dropPos: 'before'|'after'|null
  onDragStart: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
  onAddSymbol: (wlId: string, ticker: string, name: string) => void
  onBrokerChange: (wlId: string, broker: string, accountEnv: string) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ticker:string;name:string}[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const openSearch = () => { setAdding(true); setQuery(''); setResults([]); setTimeout(()=>inputRef.current?.focus(),0) }
  const closeSearch = () => { setAdding(false); setQuery(''); setResults([]) }
  const existing = new Set(watchlist.symbols.map(s=>s.ticker))

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
                onClick={() => onBrokerChange(watchlist.id, b, b === 'etoro' ? 'demo' : 'live')}
              >
                {b === 'etoro' ? 'eToro' : 'Angel'}
              </button>
            ))}
          </div>
          <button type="button" className="wt-add-symbol-btn" onClick={openSearch}>+ Add stock</button>
        </div>
      </div>

      {adding && (
        <div className="wt-add-stock-panel">
          <div className="wt-add-stock-row">
            <input ref={inputRef} value={query} onChange={e=>setQuery(e.target.value)}
              onKeyDown={e=>e.key==='Enter'&&setResults(searchSymbols(query))}
              placeholder="Search ticker or name…" className="wt-add-stock-input"/>
            <button type="button" className="wt-add-stock-search-btn"
              onClick={()=>setResults(searchSymbols(query))}>Search</button>
          </div>
          {results.length > 0 && (
            <div className="wt-add-stock-results">
              {results.map(r => {
                const already = existing.has(r.ticker)
                return (
                  <button key={r.ticker} type="button" disabled={already}
                    className={`wt-add-stock-result-row ${already?'wt-add-stock-result-row--disabled':''}`}
                    onClick={()=>{ if(!already){ onAddSymbol(watchlist.id,r.ticker,r.name); closeSearch() } }}>
                    <span className="wt-add-result-ticker">{r.ticker}</span>
                    <span className="wt-add-result-name">{r.name}</span>
                    {already && <span className="wt-add-result-exists">added</span>}
                  </button>
                )
              })}
            </div>
          )}
          {results.length===0 && query && <p className="wt-add-stock-no-results">No results for "{query}"</p>}
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
          </colgroup>
          <thead>
            <tr className="wt-sym-thead-row">
              <th className="wt-sym-th">Symbol</th>
              <th className="wt-sym-th wt-th-right">1m</th>
              <th className="wt-sym-th wt-th-right">5m</th>
              <th className="wt-sym-th wt-th-right">Chg%</th>
              <th className="wt-sym-th wt-th-right">Price</th>
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
  onAddSymbol, onBrokerChange,
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
  onAddSymbol: (wlId:string, ticker:string, name:string) => void
  onBrokerChange: (wlId:string, broker:string, accountEnv:string) => void
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
            onAddSymbol={onAddSymbol}
            onBrokerChange={onBrokerChange}
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
function MomentumPanel({ cfg, custom, onPatch, onToggleCustom, onReset }: {
  cfg: MomentumCfg; custom: boolean
  onPatch: (next: Partial<MomentumCfg>) => void
  onToggleCustom: (v: boolean) => void
  onReset: () => void
}) {
  const [advanced, setAdvanced] = useState(false)
  const [env, setEnv] = useState<'demo'|'live'>('demo')
  const off = !custom

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
        <button type="button" className="wt-deploy-btn">⚡ Deploy</button>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   Detail panel (resizable)
   ═══════════════════════════════════════════════════════════════ */
function DetailPanel({ sym, width, onResizeStart }: {
  sym: Sym|null; width: number; onResizeStart: (e:React.MouseEvent) => void
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
  const [panels, setPanels] = useState<Panel[]>(SEED)
  const [dragSrc, setDragSrc] = useState<DragSrc|null>(null)
  const [dropTgt, setDropTgt] = useState<DropTgt|null>(null)
  const [detailWidth, setDetailWidth] = useState(380)
  const resizingRef = useRef(false)

  // Active panel / selection are derived from the URL (?panel=&watchlist=&stock=)
  // so back/forward navigation restores exactly what the user was looking at.
  const activePanel = panels.find(p => p.name === state.panel) ?? panels[0]
  const activePanelId = activePanel.id
  const allWatchlists = [...activePanel.cols[0], ...activePanel.cols[1]]
  const selectedWl = allWatchlists.find(w => w.name === state.watchlist)
  const selectedSym =
    selectedWl?.symbols.find(s => s.ticker === state.stock) ??
    allWatchlists.flatMap(wl => wl.symbols).find(s => s.ticker === state.stock) ??
    null
  const selectedSymbolId = selectedSym?.id ?? null

  // Reflect the active panel in the URL when arriving without one.
  useEffect(() => {
    if (!state.panel) navigate({ panel: activePanel.name }, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.panel])

  /* ── selection ── */
  const handleSelectSymbol = (id: string) => {
    const wl = allWatchlists.find(w => w.symbols.some(s => s.id === id))
    const sym = wl?.symbols.find(s => s.id === id)
    if (!wl || !sym) return
    navigate({ tab: 'watch-trade', panel: activePanel.name, watchlist: wl.name, stock: sym.ticker })
  }

  /* ── panel actions ── */
  const handleSelectPanel = (id: string) => {
    const p = panels.find(pp => pp.id === id)
    if (!p) return
    navigate({ tab: 'watch-trade', panel: p.name, watchlist: '', stock: '' })
  }
  const handleAddPanel = () => {
    const id = `p${Date.now()}`
    const name = `Panel ${panels.length + 1}`
    setPanels(prev => [...prev, { id, name, cols:[[],[]] }])
    navigate({ tab: 'watch-trade', panel: name, watchlist: '', stock: '' })
  }

  /* ── add watchlist — goes to the shorter column ── */
  const handleAddWatchlist = () => {
    const wlId = `wl-${Date.now()}`
    setPanels(prev => prev.map(p => {
      if (p.id !== activePanelId) return p
      const [l, r] = p.cols
      const newWl: Watchlist = {
        id: wlId, name: `Watchlist ${l.length + r.length + 1}`,
        broker: 'eToro', accountEnv: 'Live', symbols: [],
      }
      return { ...p, cols: l.length <= r.length ? [[...l, newWl], r] : [l, [...r, newWl]] }
    }))
  }

  /* ── change broker/env for a watchlist ── */
  const handleBrokerChange = (wlId: string, broker: string, accountEnv: string) => {
    setPanels(prev => prev.map(p => {
      if (p.id !== activePanelId) return p
      return { ...p, cols: p.cols.map(col =>
        col.map(wl => wl.id !== wlId ? wl : { ...wl, broker, accountEnv })
      ) as [Watchlist[], Watchlist[]] }
    }))
  }

  /* ── add symbol to watchlist ── */
  const handleAddSymbol = (wlId: string, ticker: string, name: string) => {
    setPanels(prev => prev.map(p => {
      if (p.id !== activePanelId) return p
      return { ...p, cols: p.cols.map(col =>
        col.map(wl => wl.id !== wlId ? wl : { ...wl, symbols:[...wl.symbols, makeStub(ticker,name)] })
      ) as [Watchlist[], Watchlist[]] }
    }))
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

    setPanels(prev => prev.map(p => {
      if (p.id !== activePanelId) return p
      const cols: [Watchlist[], Watchlist[]] = [[ ...p.cols[0] ], [ ...p.cols[1] ]]

      // Remove from source
      const [moved] = cols[dragSrc.col].splice(dragSrc.idx, 1)

      // Insert at target
      if (dropTgt.idx === 'end') {
        cols[dropTgt.col].push(moved)
      } else {
        let insertAt = dropTgt.pos === 'after' ? dropTgt.idx + 1 : dropTgt.idx
        // If same column, adjust for removed item
        if (dragSrc.col === dropTgt.col && dragSrc.idx < insertAt) insertAt--
        cols[dropTgt.col].splice(Math.max(0, insertAt), 0, moved)
      }

      return { ...p, cols }
    }))

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

  const hasAny = activePanel.cols[0].length + activePanel.cols[1].length > 0

  return (
    <div className="wt-root">
      <PanelTabs panels={panels} activeId={activePanelId} onSelect={handleSelectPanel} onAdd={handleAddPanel}/>

      <div className="wt-body">
        <div className="wt-wl-grid-wrap">
          {!hasAny ? (
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
                    onAddSymbol={handleAddSymbol}
                    onBrokerChange={handleBrokerChange}
                  />
                ))}
              </div>
              <button type="button" className="wt-new-wl-btn" onClick={handleAddWatchlist}>
                + New watchlist
              </button>
            </>
          )}
        </div>

        <DetailPanel sym={selectedSym} width={detailWidth} onResizeStart={handleResizeStart}/>
      </div>
    </div>
  )
}
