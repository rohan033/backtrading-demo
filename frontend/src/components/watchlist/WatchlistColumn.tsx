import { useRef, useState, useEffect } from 'react'
import { GripVertical, Pencil, Plus, Trash2, TrendingDown, TrendingUp, X, Zap } from 'lucide-react'

import { Button } from '../ui/button'
import { formatBrokerMoney } from '../../lib/currency'
import {
  buildWatchlistTableGrid,
  formatWindowChangePct,
  watchlistTableMinWidthPx,
  WATCHLIST_CHANGE_WINDOWS,
  windowChangeTone,
  type WatchlistChangeWindowId,
} from '../../lib/watchlistChangeColumns'
import type { WatchlistWindowChanges } from '../../hooks/useWatchlistPriceHistory'
import {
  EMPTY_TABLE_PX,
  ROW_HEIGHT_PX,
} from '../../lib/watchlistLayout'
import {
  defaultAccountEnv,
  searchWatchlistSymbol,
  WATCHLIST_BROKER_OPTIONS,
  type WatchlistBroker,
} from '../../lib/watchlistBrokers'
import type { Watchlist, WatchlistSymbol, WatchlistTick } from '../../lib/watchlists'
import { watchlistTickKey } from '../../lib/watchlists'

type SearchHit = {
  symboltoken: string
  tradingsymbol: string
  exchange: string
}

/** Visual intensity tiers — uses Inter (font-sans) so numbers are actually readable. */
function pctBadgeStyles(value: number | null | undefined): string {
  // Base: Inter, numeric features, proper size
  const base = 'font-sans tabular-nums tracking-tight'

  if (value == null || Number.isNaN(value)) {
    return `${base} text-[13px] font-medium text-text-secondary/50`
  }
  const abs = Math.abs(value)
  const up = value > 0

  // Extreme: ≥ 3% — solid pill, glow, pulse
  if (abs >= 3) {
    return up
      ? `${base} text-[15px] font-black text-white bg-green shadow-[0_0_10px_2px_rgba(0,200,83,0.5)] animate-pulse ring-1 ring-green/70`
      : `${base} text-[15px] font-black text-white bg-red shadow-[0_0_10px_2px_rgba(255,23,68,0.5)] animate-pulse ring-1 ring-red/70`
  }
  // Strong: 1.5–3% — bright tint, ring
  if (abs >= 1.5) {
    return up
      ? `${base} text-[14px] font-bold text-green bg-green/20 ring-1 ring-green/50`
      : `${base} text-[14px] font-bold text-red bg-red/20 ring-1 ring-red/50`
  }
  // Mild: 0.5–1.5%
  if (abs >= 0.5) {
    return up
      ? `${base} text-[14px] font-semibold text-green bg-green/12`
      : `${base} text-[14px] font-semibold text-red bg-red/12`
  }
  // Tiny / flat
  if (abs === 0) return `${base} text-[13px] font-medium text-text-secondary bg-muted/20`
  return up
    ? `${base} text-[13px] font-semibold text-green/70`
    : `${base} text-[13px] font-semibold text-red/70`
}

function windowChangeStyles(tone: ReturnType<typeof windowChangeTone>) {
  if (tone === 'up') return 'text-green bg-green/12'
  if (tone === 'down') return 'text-red bg-red/12'
  if (tone === 'flat') return 'text-text-secondary bg-muted/25'
  return 'text-text-secondary/60 bg-muted/15'
}

export type DeployAllContext = {
  broker: WatchlistBroker
  accountEnv: string
  symbols: Array<{ symboltoken: string; tradingsymbol: string; exchange: string }>
  ticks: Record<string, WatchlistTick>
}

type Props = {
  watchlist: Watchlist
  /** Symbols in display order (may differ from watchlist.symbols after drag-reorder). */
  orderedSymbols?: WatchlistSymbol[]
  ticks: Record<string, WatchlistTick>
  windowChanges: WatchlistWindowChanges
  visibleChangeColumns: WatchlistChangeWindowId[]
  isMomentumWatchlist?: boolean
  onToggleMomentum?: (watchlistId: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  onBrokerChange: (id: string, broker: WatchlistBroker, accountEnv: string) => void
  onAddSymbol: (watchlistId: string, hit: SearchHit) => void
  onRemoveSymbol: (watchlistId: string, symboltoken: string) => void
  onSymbolsReordered?: (watchlistId: string, orderedTokens: string[]) => void
  onDeployAll?: (ctx: DeployAllContext) => Promise<void>
  onMetricsChange?: (metrics: { symbolCount: number; searchOpen: boolean }) => void
}

function directionStyles(direction: WatchlistTick['direction'] | undefined) {
  if (direction === 'up') {
    return {
      icon: TrendingUp,
      pill: 'bg-green/15 text-green ring-1 ring-green/25',
      text: 'text-green',
    }
  }
  if (direction === 'down') {
    return {
      icon: TrendingDown,
      pill: 'bg-red/15 text-red ring-1 ring-red/25',
      text: 'text-red',
    }
  }
  return {
    icon: null,
    pill: 'bg-muted/40 text-text-secondary',
    text: 'text-text-secondary',
  }
}

export default function WatchlistColumn({
  watchlist,
  orderedSymbols,
  ticks,
  windowChanges,
  visibleChangeColumns,
  isMomentumWatchlist = false,
  onToggleMomentum,
  onRename,
  onDelete,
  onBrokerChange,
  onAddSymbol,
  onRemoveSymbol,
  onSymbolsReordered,
  onDeployAll,
  onMetricsChange,
}: Props) {
  const broker = (watchlist.broker || 'angel') as WatchlistBroker
  const accountEnv = watchlist.account_env || defaultAccountEnv(broker)

  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(watchlist.name)
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [deployEnv, setDeployEnv] = useState<'demo' | 'live'>('demo')
  const [deploying, setDeploying] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  // Drag-to-reorder state
  const dragTokenRef = useRef<string | null>(null)
  const [dragOverToken, setDragOverToken] = useState<string | null>(null)

  const handleDeployAll = async () => {
    if (!onDeployAll || deploying || watchlist.symbols.length === 0) return
    setDeploying(true)
    try {
      await onDeployAll({
        broker,
        accountEnv: deployEnv,
        symbols: watchlist.symbols.map(s => ({
          symboltoken: s.symboltoken,
          tradingsymbol: s.tradingsymbol,
          exchange: s.exchange,
        })),
        ticks,
      })
    } finally {
      setDeploying(false)
    }
  }

  useEffect(() => {
    if (!editingName) setNameDraft(watchlist.name)
  }, [watchlist.name, editingName])

  useEffect(() => {
    if (editingName) nameInputRef.current?.focus()
  }, [editingName])

  useEffect(() => {
    onMetricsChange?.({ symbolCount: watchlist.symbols.length, searchOpen: adding })
  }, [watchlist.symbols.length, adding, onMetricsChange])

  const commitRename = () => {
    const trimmed = nameDraft.trim()
    setEditingName(false)
    if (trimmed && trimmed !== watchlist.name) {
      onRename(watchlist.id, trimmed)
    } else {
      setNameDraft(watchlist.name)
    }
  }

  const runSearch = async () => {
    setSearching(true)
    try {
      setResults(await searchWatchlistSymbol(broker, query, accountEnv))
    } catch {
      setResults([])
    } finally {
      setSearching(false)
    }
  }

  const displaySymbols = orderedSymbols ?? watchlist.symbols
  const existingTokens = new Set(watchlist.symbols.map(s => s.symboltoken))
  const tableGrid = buildWatchlistTableGrid(visibleChangeColumns)
  const tableMinWidth = watchlistTableMinWidthPx(visibleChangeColumns.length)
  const windowColumnLabels = new Map(
    WATCHLIST_CHANGE_WINDOWS.map(window => [window.id, window.label]),
  )

  const handleDragStart = (token: string) => {
    dragTokenRef.current = token
  }

  const handleDragOver = (e: React.DragEvent, token: string) => {
    e.preventDefault()
    setDragOverToken(token)
  }

  const handleDrop = (e: React.DragEvent, targetToken: string) => {
    e.preventDefault()
    const sourceToken = dragTokenRef.current
    dragTokenRef.current = null
    setDragOverToken(null)
    if (!sourceToken || sourceToken === targetToken) return
    const tokens = displaySymbols.map(s => s.symboltoken)
    const fromIdx = tokens.indexOf(sourceToken)
    const toIdx = tokens.indexOf(targetToken)
    if (fromIdx === -1 || toIdx === -1) return
    tokens.splice(fromIdx, 1)
    tokens.splice(toIdx, 0, sourceToken)
    onSymbolsReordered?.(watchlist.id, tokens)
  }

  const handleDragEnd = () => {
    dragTokenRef.current = null
    setDragOverToken(null)
  }

  return (
    <div className={`flex flex-col ${isMomentumWatchlist ? 'ring-1 ring-amber-500/40' : ''}`}>
      <header
        className="grid shrink-0 cursor-grab grid-cols-[auto_auto_1fr_auto_auto_auto_auto] items-center gap-1.5 border-b border-border bg-secondary/40 px-2.5 py-2 active:cursor-grabbing"
        data-watchlist-drag
      >
        <button
          type="button"
          data-no-drag
          onClick={() => setAdding(true)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-accent ring-1 ring-accent/30 hover:bg-accent/10"
          title="Add symbol"
        >
          <Plus className="h-4 w-4" />
        </button>
        <select
          data-no-drag
          value={broker}
          onChange={e => {
            const next = e.target.value as WatchlistBroker
            onBrokerChange(watchlist.id, next, defaultAccountEnv(next))
          }}
          className="h-7 rounded-md border border-border bg-primary px-1.5 text-xs outline-none focus:border-accent/50"
          title="Broker"
        >
          {WATCHLIST_BROKER_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {editingName ? (
          <input
            ref={nameInputRef}
            value={nameDraft}
            onChange={e => setNameDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') {
                setNameDraft(watchlist.name)
                setEditingName(false)
              }
            }}
            className="min-w-0 rounded-md border border-accent/40 bg-primary px-2 py-1 text-sm font-medium outline-none"
            data-no-drag
          />
        ) : (
          <h3
            className="min-w-0 truncate px-0.5 text-sm font-semibold text-text-primary"
            title={watchlist.name}
            data-watchlist-drag
          >
            {watchlist.name}
          </h3>
        )}
        <button
          type="button"
          data-no-drag
          onClick={() => setEditingName(true)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-card hover:text-text-primary"
          title="Rename"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        {onToggleMomentum && (
          <button
            type="button"
            data-no-drag
            onClick={() => onToggleMomentum(watchlist.id)}
            title={isMomentumWatchlist ? 'Momentum trading ON — click to disable' : 'Enable momentum trading for this watchlist'}
            className={`flex h-7 items-center gap-1 rounded-md border px-2 text-[10px] font-bold transition-colors ${
              isMomentumWatchlist
                ? 'border-amber-500/60 bg-amber-500/20 text-amber-300 hover:bg-amber-500/30'
                : 'border-border bg-transparent text-text-secondary hover:border-amber-500/40 hover:bg-amber-500/10 hover:text-amber-400'
            }`}
          >
            <Zap className="h-3 w-3" />
            {isMomentumWatchlist ? 'Momentum' : ''}
          </button>
        )}
        {onDeployAll ? (
          <div className="flex items-center gap-0.5" data-no-drag>
            <select
              value={deployEnv}
              onChange={e => setDeployEnv(e.target.value as 'demo' | 'live')}
              disabled={deploying || watchlist.symbols.length === 0}
              className="h-7 rounded-l-md border border-r-0 border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] font-semibold text-amber-300 outline-none focus:border-amber-500/60 disabled:opacity-50"
            >
              <option value="demo">Demo</option>
              <option value="live">Live</option>
            </select>
            <button
              type="button"
              onClick={handleDeployAll}
              disabled={deploying || watchlist.symbols.length === 0}
              className="flex h-7 items-center gap-1 rounded-r-md border border-amber-500/40 bg-amber-500/10 px-2 text-[10px] font-bold text-amber-300 hover:bg-amber-500/20 disabled:opacity-50"
              title={`Deploy all ${watchlist.symbols.length} symbol(s) as strategies on ${deployEnv}`}
            >
              <Zap className="h-3 w-3" />
              {deploying ? '…' : 'All'}
            </button>
          </div>
        ) : null}
        <button
          type="button"
          data-no-drag
          onClick={() => onDelete(watchlist.id)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-red/10 hover:text-red"
          title="Delete watchlist"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </header>

      {adding && (
        <div className="shrink-0 space-y-2 border-b border-border bg-primary/50 px-2.5 py-2" data-no-drag>
          <div className="flex gap-2">
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && runSearch()}
              placeholder={broker === 'etoro' ? 'Search symbol…' : 'Search NSE…'}
              className="min-w-0 flex-1 rounded-md border border-border bg-primary px-2.5 py-1.5 text-sm outline-none focus:border-accent/50"
            />
            <Button type="button" size="sm" onClick={runSearch} disabled={searching}>
              {searching ? '…' : 'Search'}
            </Button>
          </div>
          {results.length > 0 && (
            <div className="max-h-24 overflow-y-auto rounded-md border border-border bg-primary text-sm">
              {results.map(hit => (
                <button
                  key={`${hit.exchange}-${hit.symboltoken}`}
                  type="button"
                  disabled={existingTokens.has(hit.symboltoken)}
                  onClick={() => {
                    onAddSymbol(watchlist.id, hit)
                    setQuery('')
                    setResults([])
                    setAdding(false)
                  }}
                  className="block w-full border-b border-border/40 px-2.5 py-1.5 text-left last:border-0 hover:bg-accent/5 disabled:opacity-40"
                >
                  <span className="font-medium">{hit.tradingsymbol}</span>
                  <span className="ml-1 text-text-secondary">{hit.exchange}</span>
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              setAdding(false)
              setQuery('')
              setResults([])
            }}
            className="text-xs text-text-secondary hover:text-text-primary"
          >
            Cancel
          </button>
        </div>
      )}

      <div className="min-w-0 flex-1 px-2.5 pb-2.5 pt-2">
        <div className="overflow-x-auto rounded-lg border border-border bg-secondary/20 text-sm">
          <div style={{ minWidth: tableMinWidth }}>
          <div
            className="grid items-center border-b border-border bg-secondary/80 text-[10px] font-semibold uppercase tracking-wide text-text-secondary"
            style={{ gridTemplateColumns: tableGrid }}
          >
            <div className="truncate px-2 py-2">Symbol</div>
            <div className="px-1.5 py-2 text-right">Last</div>
            <div className="px-0.5 py-2 text-center">Trend</div>
            {visibleChangeColumns.map(columnId => (
              <div key={columnId} className="px-1 py-2 text-right">
                {windowColumnLabels.get(columnId)}
              </div>
            ))}
            <div className="px-1.5 py-2 text-right">Tick</div>
            <div className="px-0.5 py-2" aria-hidden />
          </div>

          {displaySymbols.length === 0 && (
            <div
              className="px-3 text-center text-sm text-text-secondary"
              style={{ height: EMPTY_TABLE_PX, lineHeight: `${EMPTY_TABLE_PX}px` }}
            >
              Add symbols with the + button above
            </div>
          )}

          {displaySymbols.map((symbol: WatchlistSymbol, rowIndex: number) => {
            const tickKey = watchlistTickKey(broker, accountEnv, symbol.symboltoken)
            const tick = ticks[tickKey]
            const pct = tick?.change_pct
            const dir = tick?.direction
            const styles = directionStyles(dir)
            const DirIcon = styles.icon
            const symbolWindows = windowChanges[tickKey]
            const isFirst = rowIndex === 0
            const isDragOver = dragOverToken === symbol.symboltoken

            return (
              <div
                key={symbol.symboltoken}
                draggable
                onDragStart={() => handleDragStart(symbol.symboltoken)}
                onDragOver={e => handleDragOver(e, symbol.symboltoken)}
                onDrop={e => handleDrop(e, symbol.symboltoken)}
                onDragEnd={handleDragEnd}
                className={`group grid items-center border-t transition-colors hover:bg-accent/[0.04] ${
                  isDragOver
                    ? 'border-t-2 border-t-accent bg-accent/10'
                    : 'border-t-border/40'
                }`}
                style={{ gridTemplateColumns: tableGrid, height: ROW_HEIGHT_PX }}
              >
                {/* Drag handle + first-row crown */}
                <div className="flex min-w-0 items-center gap-1 px-1">
                  <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-text-secondary/30 opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing" />
                  {isMomentumWatchlist && isFirst && (
                    <span
                      title="Next momentum trade candidate"
                      className="shrink-0 text-[10px] leading-none text-amber-400"
                    >
                      ★
                    </span>
                  )}
                  <span
                    className="min-w-0 truncate font-sans text-[14px] font-semibold text-text-primary"
                    title={symbol.tradingsymbol}
                  >
                    {symbol.tradingsymbol}
                  </span>
                </div>
                <div className="flex justify-end px-1.5 font-sans text-[13px] font-medium tabular-nums text-text-primary">
                  {tick ? (
                    formatBrokerMoney(broker, tick.ltp, 2)
                  ) : (
                    <span className="text-text-secondary/60">…</span>
                  )}
                </div>
                <div className="flex justify-center px-1">
                  <span
                    className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${styles.pill}`}
                    title={dir === 'up' ? 'Up' : dir === 'down' ? 'Down' : 'Waiting'}
                  >
                    {DirIcon ? (
                      <DirIcon className="h-4 w-4" strokeWidth={2.5} />
                    ) : (
                      <span className="text-xs text-text-secondary/50">·</span>
                    )}
                  </span>
                </div>
                {visibleChangeColumns.map(columnId => {
                  const value = symbolWindows?.[columnId] ?? null
                  return (
                    <div key={columnId} className="flex justify-end px-1">
                      <span
                        className={`rounded-md px-2 py-0.5 tabular-nums whitespace-nowrap tracking-tight transition-colors ${pctBadgeStyles(value)}`}
                        title={value == null ? 'Collecting local history…' : undefined}
                      >
                        {value == null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`}
                      </span>
                    </div>
                  )
                })}
                <div className="flex justify-end px-1.5">
                  <span
                    className={`rounded-md px-2 py-0.5 tabular-nums whitespace-nowrap tracking-tight transition-colors ${pctBadgeStyles(pct)}`}
                  >
                    {tick
                      ? (pct == null || Number.isNaN(pct) ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`)
                      : <span className="text-text-secondary/40 text-[11px]">…</span>
                    }
                  </span>
                </div>
                <div className="flex justify-center px-0.5">
                  <button
                    type="button"
                    onClick={() => onRemoveSymbol(watchlist.id, symbol.symboltoken)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-secondary opacity-0 transition-opacity group-hover:opacity-100 hover:bg-red/10 hover:text-red"
                    title="Remove"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )
          })}
          </div>
        </div>
      </div>
    </div>
  )
}
