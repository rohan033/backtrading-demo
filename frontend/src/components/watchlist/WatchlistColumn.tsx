import { useEffect, useRef, useState } from 'react'
import { Pencil, Plus, Trash2, X } from 'lucide-react'

import { Button } from '../ui/button'
import { formatBrokerMoney } from '../../lib/currency'
import type { WatchlistCardLayout } from '../../lib/watchlistLayout'
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
  layout: WatchlistCardLayout
  ticks: Record<string, WatchlistTick>
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  onBrokerChange: (id: string, broker: WatchlistBroker, accountEnv: string) => void
  onAddSymbol: (watchlistId: string, hit: SearchHit) => void
  onRemoveSymbol: (watchlistId: string, symboltoken: string) => void
}

const ROW_GRID =
  'grid grid-cols-[minmax(0,1fr)_4.25rem_1.1rem_3rem] items-center gap-1'

function pctClass(direction: WatchlistTick['direction'] | undefined) {
  if (direction === 'up') return 'text-green'
  if (direction === 'down') return 'text-red'
  return 'text-text-secondary'
}

function directionGlyph(direction: WatchlistTick['direction'] | undefined) {
  if (direction === 'up') return '▲'
  if (direction === 'down') return '▼'
  return '—'
}

export default function WatchlistColumn({
  watchlist,
  layout,
  ticks,
  onRename,
  onDelete,
  onBrokerChange,
  onAddSymbol,
  onRemoveSymbol,
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
  const listHeight = layout.bodyHeight

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header
        className="grid shrink-0 cursor-grab grid-cols-[auto_auto_1fr_auto_auto] items-center gap-0.5 border-b border-border px-1.5 py-1 active:cursor-grabbing"
        data-watchlist-drag
      >
        <button
          type="button"
          data-no-drag
          onClick={() => setAdding(true)}
          className="rounded p-1 text-accent hover:bg-accent/10"
          title="Add symbol"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <select
          data-no-drag
          value={broker}
          onChange={e => {
            const next = e.target.value as WatchlistBroker
            onBrokerChange(watchlist.id, next, defaultAccountEnv(next))
          }}
          className="w-[4.75rem] rounded border border-border bg-primary px-0.5 py-0.5 text-[9px] outline-none focus:border-accent/60"
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
            className="min-w-0 rounded border border-accent/50 bg-primary px-1 py-0.5 text-[10px] font-semibold outline-none"
            data-no-drag
          />
        ) : (
          <h3
            className="min-w-0 truncate px-0.5 text-[10px] font-semibold"
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
          className="rounded p-1 text-text-secondary hover:bg-accent/10 hover:text-text-primary"
          title="Rename"
        >
          <Pencil className="h-3 w-3" />
        </button>
        <button
          type="button"
          data-no-drag
          onClick={() => onDelete(watchlist.id)}
          className="rounded p-1 text-text-secondary hover:bg-red/10 hover:text-red"
          title="Delete watchlist"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </header>

      {adding && (
        <div className="space-y-1 border-b border-border px-2 pb-2" data-no-drag>
          <div className="flex gap-1">
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && runSearch()}
              placeholder={broker === 'etoro' ? 'Symbol…' : 'NSE…'}
              className="min-w-0 flex-1 rounded border border-border bg-primary px-2 py-1 text-[10px] outline-none focus:border-accent/60"
            />
            <Button type="button" size="xs" onClick={runSearch} disabled={searching}>
              {searching ? '…' : 'Go'}
            </Button>
          </div>
          {results.length > 0 && (
            <div className="max-h-24 overflow-y-auto rounded border border-border bg-primary">
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
                  className="block w-full border-b border-border/40 px-2 py-1 text-left text-[10px] last:border-0 hover:bg-accent/5 disabled:opacity-40"
                >
                  <span className="font-medium">{hit.tradingsymbol}</span>
                  <span className="text-text-secondary"> · {hit.exchange}</span>
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
            className="text-[9px] text-text-secondary hover:text-text-primary"
          >
            Cancel
          </button>
        </div>
      )}

      <div
        className={`${ROW_GRID} shrink-0 border-b border-border/50 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-wide text-text-secondary`}
      >
        <span>Symbol</span>
        <span className="text-right">Price</span>
        <span className="text-center">Sig</span>
        <span className="text-right">Chg</span>
      </div>

      <ul
        className="min-h-0 flex-1 overflow-y-auto px-1.5 py-0.5"
        style={{ height: listHeight, maxHeight: listHeight }}
      >
        {watchlist.symbols.length === 0 && (
          <li className="flex h-full items-center justify-center text-[9px] text-text-secondary">
            Add symbols with +
          </li>
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
          return (
            <li
              key={symbol.symboltoken}
              className={`group relative ${ROW_GRID} h-7 rounded px-1 hover:bg-accent/5`}
            >
              <span className="truncate text-[10px] font-semibold" title={symbol.tradingsymbol}>
                {symbol.tradingsymbol}
              </span>
              <span className="text-right text-[10px] tabular-nums text-text-primary">
                {tick ? formatBrokerMoney(broker, tick.ltp, 2) : '—'}
              </span>
              <span
                className={`text-center text-[10px] font-bold leading-none ${pctClass(dir)}`}
                title={dir === 'up' ? 'Up' : dir === 'down' ? 'Down' : 'Unchanged'}
              >
                {directionGlyph(dir)}
              </span>
              <span className={`text-right text-[10px] font-semibold tabular-nums ${pctClass(dir)}`}>
                {pctLabel}
              </span>
              <button
                type="button"
                onClick={() => onRemoveSymbol(watchlist.id, symbol.symboltoken)}
                className="absolute -right-0.5 top-1/2 -translate-y-1/2 rounded bg-card/90 p-0.5 text-text-secondary opacity-0 shadow-sm group-hover:opacity-100 hover:text-red"
                title="Remove"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
