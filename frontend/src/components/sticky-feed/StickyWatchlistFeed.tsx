import { ChevronDown, ChevronUp, Zap } from 'lucide-react'
import { Link } from 'react-router-dom'

import { useStickyWatchlistFeed } from '../../hooks/useStickyWatchlistFeed'
import {
  formatWindowChangePct,
  windowChangeTone,
} from '../../lib/watchlistChangeColumns'
import {
  STICKY_FEED_RANK_WINDOWS,
  STICKY_FEED_SORT_INTERVALS,
  stickyFeedSortIntervalLabel,
} from '../../lib/stickyFeed'
import type { WindowChangesLookup } from '../../lib/watchlistAutoSort'
import type { WatchlistChangeWindowId } from '../../lib/watchlistChangeColumns'
import type { RankedWatchlistSymbol } from '../../lib/watchlistTopPerformers'

function changeTextClass(change: number | null): string {
  const tone = windowChangeTone(change)
  if (tone === 'up') return 'text-green font-bold'
  if (tone === 'down') return 'text-red font-bold'
  if (tone === 'flat') return 'text-text-secondary font-semibold'
  return 'text-text-secondary/50'
}

function TickerCell({
  row,
  windowChanges,
  columnId,
}: {
  row: RankedWatchlistSymbol
  windowChanges: WindowChangesLookup
  columnId: WatchlistChangeWindowId
}) {
  const label = row.symbol.tradingsymbol || row.symbol.symbol
  const demoActive = !row.momentumLive
  const change = windowChanges[row.tickKey]?.[columnId] ?? row.change

  return (
    <Link
      to="/watchlist"
      className="flex min-w-[9.5rem] shrink-0 items-center gap-2 rounded-md border border-pink-500/15 bg-background/40 px-2 py-1 transition-colors hover:bg-background/70"
      title={`${label} · ${row.watchlistName}`}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-bold leading-tight">{label}</div>
        <div className={`text-[10px] tabular-nums ${changeTextClass(change)}`}>
          {formatWindowChangePct(change)}
        </div>
      </div>
      <div className="grid shrink-0 grid-cols-2 gap-0.5">
        <span
          className={`flex h-4 w-4 items-center justify-center rounded text-[7px] font-bold ${
            demoActive
              ? 'bg-background text-text-primary ring-1 ring-border/60'
              : 'text-text-secondary/35'
          }`}
          title="Demo deploy"
        >
          D
        </span>
        <span
          className={`flex h-4 w-4 items-center justify-center rounded ${
            row.momentumNormal
              ? 'bg-amber-500/25 text-amber-300 ring-1 ring-amber-500/40'
              : 'text-text-secondary/25'
          }`}
          title="Momentum (5% TP / 1% SL)"
        >
          <Zap className="h-2.5 w-2.5" />
        </span>
        <span
          className={`flex h-4 w-4 items-center justify-center rounded text-[7px] font-bold ${
            row.momentumLive
              ? 'bg-red/25 text-red ring-1 ring-red/40'
              : 'text-text-secondary/35'
          }`}
          title="Live deploy"
        >
          L
        </span>
        <span
          className={`flex h-4 w-4 items-center justify-center rounded ${
            row.momentumNoTp
              ? 'bg-blue-500/25 text-blue-300 ring-1 ring-blue-500/40'
              : 'text-text-secondary/25'
          }`}
          title="Momentum · no take-profit"
        >
          <Zap className="h-2.5 w-2.5" />
        </span>
      </div>
    </Link>
  )
}

export default function StickyWatchlistFeed() {
  const {
    topPerformers,
    windowChanges,
    config,
    updateConfig,
    connected,
    hasSymbols,
  } = useStickyWatchlistFeed()

  if (!hasSymbols) return null

  const columnLabel = STICKY_FEED_RANK_WINDOWS.find(window => window.id === config.column)?.label
    ?? config.column
  const sortLabel = stickyFeedSortIntervalLabel(config.sortIntervalMs)

  if (!config.expanded) {
    return (
      <div className="shrink-0 border-b border-pink-500/20 bg-pink-500/10 px-3 py-1">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => updateConfig({ expanded: true })}
            className="flex min-w-0 flex-1 items-center gap-2 text-left text-[11px] font-semibold text-text-primary"
          >
            <span className="truncate">
              Top 5 by {columnLabel}
              <span className="text-text-secondary/70"> · sort {sortLabel}</span>
              {!connected ? <span className="ml-1 text-text-secondary/60">· connecting…</span> : null}
            </span>
            <span className="hidden sm:inline text-[10px] font-normal text-text-secondary">
              {topPerformers.map(row => row.symbol.tradingsymbol).join(' · ')}
            </span>
          </button>
          <button
            type="button"
            onClick={() => updateConfig({ expanded: true })}
            className="rounded p-1 text-text-secondary hover:bg-background/50 hover:text-text-primary"
            title="Expand sticky feed"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="shrink-0 border-b border-pink-500/20 bg-pink-500/10">
      <div className="flex items-stretch gap-2 px-2 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
          {topPerformers.length ? (
            topPerformers.map(row => (
              <TickerCell
                key={`${row.watchlistId}:${row.symbol.symboltoken}`}
                row={row}
                windowChanges={windowChanges}
                columnId={config.column}
              />
            ))
          ) : (
            <span className="px-2 text-[11px] text-text-secondary">
              Waiting for % change data…
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1 border-l border-pink-500/15 pl-2">
          <label className="sr-only" htmlFor="sticky-feed-rank-window">Rank window</label>
          <select
            id="sticky-feed-rank-window"
            value={config.column}
            onChange={event =>
              updateConfig({ column: event.target.value as typeof config.column })
            }
            className="h-7 cursor-pointer rounded border border-border/60 bg-background/60 px-1.5 text-[10px] font-semibold text-text-primary outline-none"
            title="Top 5 rank window"
          >
            {STICKY_FEED_RANK_WINDOWS.map(window => (
              <option key={window.id} value={window.id}>
                Top 5 by {window.label}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor="sticky-feed-sort-interval">Sort interval</label>
          <select
            id="sticky-feed-sort-interval"
            value={config.sortIntervalMs}
            onChange={event =>
              updateConfig({ sortIntervalMs: Number(event.target.value) })
            }
            className="h-7 cursor-pointer rounded border border-border/60 bg-background/60 px-1.5 text-[10px] font-semibold text-text-primary outline-none"
            title="How often top-5 order re-sorts (live % still updates every second)"
          >
            {STICKY_FEED_SORT_INTERVALS.map(option => (
              <option key={option.ms} value={option.ms}>
                Sort {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => updateConfig({ expanded: false })}
            className="rounded p-1 text-text-secondary hover:bg-background/50 hover:text-text-primary"
            title="Collapse sticky feed"
          >
            <ChevronUp className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
