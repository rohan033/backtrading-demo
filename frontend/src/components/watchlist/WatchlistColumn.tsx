import { useEffect, useRef, useState } from 'react'
import { Pencil, Plus, Trash2, TrendingDown, TrendingUp, X } from 'lucide-react'

import { Button } from '../ui/button'
import { formatBrokerMoney } from '../../lib/currency'
import {
  EMPTY_TABLE_PX,
  ROW_HEIGHT_PX,
  WATCHLIST_TABLE_GRID,
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

type Props = {
  watchlist: Watchlist
  ticks: Record<string, WatchlistTick>
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  onBrokerChange: (id: string, broker: WatchlistBroker, accountEnv: string) => void
  onAddSymbol: (watchlistId: string, hit: SearchHit) => void
  onRemoveSymbol: (watchlistId: string, symboltoken: string) => void
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
  ticks,
  onRename,
  onDelete,
  onBrokerChange,
  onAddSymbol,
  onRemoveSymbol,
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
  const nameInputRef = useRef<HTMLInputElement>(null)

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

  const existingTokens = new Set(watchlist.symbols.map(s => s.symboltoken))

  return (
    <div className="flex flex-col">
      <header
        className="grid shrink-0 cursor-grab grid-cols-[auto_auto_1fr_auto_auto] items-center gap-1.5 border-b border-border bg-secondary/40 px-2.5 py-2 active:cursor-grabbing"
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

      <div className="px-2.5 pb-2.5 pt-2">
        <div className="overflow-hidden rounded-lg border border-border bg-secondary/20 text-sm">
          <div
            className="grid items-center border-b border-border bg-secondary/80 text-xs font-semibold uppercase tracking-wide text-text-secondary"
            style={{ gridTemplateColumns: WATCHLIST_TABLE_GRID }}
          >
            <div className="truncate px-3 py-2">Symbol</div>
            <div className="px-2 py-2 text-right">Last</div>
            <div className="px-1 py-2 text-center">Trend</div>
            <div className="px-2 py-2 text-right">Chg%</div>
            <div className="px-0.5 py-2" aria-hidden />
          </div>

          {watchlist.symbols.length === 0 && (
            <div
              className="px-3 text-center text-sm text-text-secondary"
              style={{ height: EMPTY_TABLE_PX, lineHeight: `${EMPTY_TABLE_PX}px` }}
            >
              Add symbols with the + button above
            </div>
          )}

          {watchlist.symbols.map((symbol: WatchlistSymbol) => {
            const tickKey = watchlistTickKey(broker, accountEnv, symbol.symboltoken)
            const tick = ticks[tickKey]
            const pct = tick?.change_pct
            const pctLabel =
              pct === undefined || Number.isNaN(pct)
                ? '—'
                : `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`
            const dir = tick?.direction
            const styles = directionStyles(dir)
            const DirIcon = styles.icon

            return (
              <div
                key={symbol.symboltoken}
                className="group grid items-center border-t border-border/40 transition-colors hover:bg-accent/[0.04]"
                style={{ gridTemplateColumns: WATCHLIST_TABLE_GRID, height: ROW_HEIGHT_PX }}
              >
                <div
                  className="min-w-0 truncate px-3 font-semibold text-text-primary"
                  title={symbol.tradingsymbol}
                >
                  {symbol.tradingsymbol}
                </div>
                <div className="flex justify-end px-2 font-mono tabular-nums text-text-primary">
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
                <div className="flex justify-end px-2">
                  <span
                    className={`rounded-md px-2 py-0.5 font-mono text-sm font-semibold tabular-nums ${styles.text} ${
                      dir === 'up' ? 'bg-green/12' : dir === 'down' ? 'bg-red/12' : 'bg-muted/25'
                    }`}
                  >
                    {tick ? pctLabel : (
                      <span className="font-normal text-text-secondary/60">…</span>
                    )}
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
  )
}
