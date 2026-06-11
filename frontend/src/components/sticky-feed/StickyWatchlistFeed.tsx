import { useCallback, useEffect, useState, type MouseEvent } from 'react'
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

const STICKY_BAR_CLASS =
  'shrink-0 border-b border-slate-300/15 bg-slate-200/[0.06]'
const SELECT_WRAP_CLASS =
  'inline-flex items-center overflow-hidden rounded-md border border-slate-300/25 bg-card shadow-sm'
const SELECT_CLASS =
  'h-10 min-w-[9rem] cursor-pointer border-0 bg-card px-3 pr-8 text-xs font-semibold text-text-primary outline-none [color-scheme:dark]'

const ACTION_CELL_BASE =
  'flex h-full min-w-[2.5rem] items-center justify-center rounded-md border border-black/15 text-sm font-bold shadow-sm transition-colors'
const DEMO_CELL =
  'bg-[#C8F0C8] text-black hover:bg-[#B4E8B4]'
const DEMO_CELL_ACTIVE = 'bg-[#9FE09F] text-black ring-2 ring-inset ring-green-700/30'
const LIVE_CELL =
  'bg-[#FFC8C8] text-black hover:bg-[#FFB4B4]'
const LIVE_CELL_ACTIVE = 'bg-[#FFAAAA] text-black ring-2 ring-inset ring-red-700/30'
const MOMENTUM_TP_CELL =
  'bg-[#FFE566] text-amber-950 hover:bg-[#FFD84D]'
const MOMENTUM_TP_CELL_ACTIVE = 'bg-[#F5C518] ring-2 ring-inset ring-amber-700/35'
const MOMENTUM_NO_TP_CELL =
  'bg-[#B8D4FF] text-blue-950 hover:bg-[#A3C8FF]'
const MOMENTUM_NO_TP_CELL_ACTIVE = 'bg-[#7EB3FF] ring-2 ring-inset ring-blue-700/35'

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
  onSelectDemo,
  onSelectLive,
  onRequestMomentum,
}: {
  row: RankedWatchlistSymbol
  windowChanges: WindowChangesLookup
  columnId: WatchlistChangeWindowId
  onSelectDemo: (row: RankedWatchlistSymbol) => void
  onSelectLive: (row: RankedWatchlistSymbol) => void
  onRequestMomentum: (row: RankedWatchlistSymbol, noTakeProfit: boolean) => void
}) {
  const label = row.symbol.tradingsymbol || row.symbol.symbol
  const liveSelected = row.momentumLive
  const demoSelected = !liveSelected
  const change = windowChanges[row.tickKey]?.[columnId] ?? row.change

  const stop = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <div
      className="flex h-20 min-w-[12.5rem] shrink-0 overflow-hidden border-x border-[#E8D48A]/80 bg-card/90"
      title={`${label} · ${row.watchlistName}`}
    >
      <Link
        to="/watchlist"
        className="flex min-w-0 flex-1 flex-col justify-center border-r border-[#E8D48A]/80 px-3 transition-colors hover:bg-card"
      >
        <div className="truncate text-sm font-bold leading-tight">{label}</div>
        <div className={`text-xs tabular-nums ${changeTextClass(change)}`}>
          {formatWindowChangePct(change)}
        </div>
      </Link>

      <div className="grid h-full shrink-0 grid-cols-2 grid-rows-2 gap-1.5 bg-card/60 p-1.5">
        <button
          type="button"
          aria-pressed={demoSelected}
          onClick={event => {
            stop(event)
            onSelectDemo(row)
          }}
          className={`${ACTION_CELL_BASE} ${DEMO_CELL} ${
            demoSelected ? DEMO_CELL_ACTIVE : 'opacity-50'
          }`}
          title="Select demo as the deploy target"
        >
          D
        </button>
        <button
          type="button"
          onClick={event => {
            stop(event)
            onRequestMomentum(row, false)
          }}
          className={`${ACTION_CELL_BASE} ${MOMENTUM_TP_CELL} ${
            row.momentumNormal ? MOMENTUM_TP_CELL_ACTIVE : 'opacity-80'
          }`}
          title="Place momentum order (5% TP / 1% SL)"
        >
          <Zap className="h-4 w-4 stroke-[2.5]" />
        </button>
        <button
          type="button"
          aria-pressed={liveSelected}
          onClick={event => {
            stop(event)
            onSelectLive(row)
          }}
          className={`${ACTION_CELL_BASE} ${LIVE_CELL} ${
            liveSelected ? LIVE_CELL_ACTIVE : 'opacity-50'
          }`}
          title="Select live as the deploy target"
        >
          L
        </button>
        <button
          type="button"
          onClick={event => {
            stop(event)
            onRequestMomentum(row, true)
          }}
          className={`${ACTION_CELL_BASE} ${MOMENTUM_NO_TP_CELL} ${
            row.momentumNoTp ? MOMENTUM_NO_TP_CELL_ACTIVE : 'opacity-80'
          }`}
          title="Place momentum order · no take-profit (let it run)"
        >
          <Zap className="h-4 w-4 stroke-[2.5]" />
        </button>
      </div>
    </div>
  )
}

type PendingDeploy = {
  row: RankedWatchlistSymbol
  noTakeProfit: boolean
}

function DeployConfirmDialog({
  pending,
  onApprove,
  onCancel,
}: {
  pending: PendingDeploy
  onApprove: () => void
  onCancel: () => void
}) {
  const [secondsLeft, setSecondsLeft] = useState(10)

  useEffect(() => {
    setSecondsLeft(10)
    const id = window.setInterval(() => {
      setSecondsLeft(prev => {
        if (prev <= 1) {
          window.clearInterval(id)
          onCancel()
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => window.clearInterval(id)
  }, [pending, onCancel])

  const label = pending.row.symbol.tradingsymbol || pending.row.symbol.symbol
  const env = pending.row.momentumLive ? 'LIVE' : 'DEMO'
  const bracket = pending.noTakeProfit ? 'No take-profit · 1% SL' : '5% TP · 1% SL'

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="deploy-confirm-title"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm overflow-hidden rounded-xl border border-slate-300/20 bg-card shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="border-b border-slate-300/15 px-5 py-4">
          <h2 id="deploy-confirm-title" className="text-base font-bold text-text-primary">
            Place momentum order?
          </h2>
          <p className="mt-1 text-xs text-text-secondary">
            Auto-cancels in <span className="font-bold tabular-nums text-text-primary">{secondsLeft}s</span>
          </p>
        </div>

        <dl className="space-y-2 px-5 py-4 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-text-secondary">Symbol</dt>
            <dd className="font-bold text-text-primary">{label}</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-text-secondary">Environment</dt>
            <dd>
              <span
                className={`rounded px-2 py-0.5 text-xs font-bold ${
                  env === 'LIVE'
                    ? 'bg-[#FFC8C8] text-red-900'
                    : 'bg-[#C8F0C8] text-green-900'
                }`}
              >
                {env}
              </span>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-text-secondary">Bracket</dt>
            <dd className="font-semibold text-text-primary">{bracket}</dd>
          </div>
        </dl>

        <div className="flex items-center justify-end gap-2 border-t border-slate-300/15 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-slate-300/25 px-3 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-background/60 hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onApprove}
            autoFocus
            className="rounded-md bg-green-600 px-4 py-2 text-sm font-bold text-white shadow-sm transition-colors hover:bg-green-500"
          >
            Approve ({secondsLeft}s)
          </button>
        </div>
      </div>
    </div>
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
    setSymbolDeployEnv,
    deploySymbolMomentum,
  } = useStickyWatchlistFeed()

  const [pendingDeploy, setPendingDeploy] = useState<PendingDeploy | null>(null)

  const handleRequestMomentum = useCallback(
    (row: RankedWatchlistSymbol, noTakeProfit: boolean) => {
      setPendingDeploy({ row, noTakeProfit })
    },
    [],
  )

  const handleCancelDeploy = useCallback(() => setPendingDeploy(null), [])

  const handleApproveDeploy = useCallback(() => {
    setPendingDeploy(current => {
      if (current) {
        void deploySymbolMomentum({
          watchlistId: current.row.watchlistId,
          symboltoken: current.row.symbol.symboltoken,
          tradingsymbol: current.row.symbol.tradingsymbol || current.row.symbol.symbol,
          exchange: current.row.symbol.exchange,
          tickKey: current.row.tickKey,
          noTakeProfit: current.noTakeProfit,
        })
      }
      return null
    })
  }, [deploySymbolMomentum])

  if (!hasSymbols) return null

  const columnLabel = STICKY_FEED_RANK_WINDOWS.find(window => window.id === config.column)?.label
    ?? config.column
  const sortLabel = stickyFeedSortIntervalLabel(config.sortIntervalMs)

  if (!config.expanded) {
    return (
      <div className={`${STICKY_BAR_CLASS} px-3 py-2`}>
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
    <>
      {pendingDeploy ? (
        <DeployConfirmDialog
          pending={pendingDeploy}
          onApprove={handleApproveDeploy}
          onCancel={handleCancelDeploy}
        />
      ) : null}
      <div className={`${STICKY_BAR_CLASS} overflow-hidden`}>
      <div className="flex h-20 min-h-20 items-stretch">
        <div className="flex h-full min-h-0 min-w-0 flex-1 items-stretch gap-px overflow-x-auto">
          {topPerformers.length ? (
            topPerformers.map(row => (
              <TickerCell
                key={`${row.watchlistId}:${row.symbol.symboltoken}`}
                row={row}
                windowChanges={windowChanges}
                columnId={config.column}
                onSelectDemo={r => setSymbolDeployEnv(r.watchlistId, r.symbol.symboltoken, 'demo')}
                onSelectLive={r => setSymbolDeployEnv(r.watchlistId, r.symbol.symboltoken, 'live')}
                onRequestMomentum={handleRequestMomentum}
              />
            ))
          ) : (
            <span className="px-2 text-xs font-medium text-text-primary/80">
              Waiting for % change data…
            </span>
          )}
        </div>

        <div className="flex h-full shrink-0 items-center gap-2 self-stretch border-l border-slate-300/20 px-2">
          <div className={SELECT_WRAP_CLASS}>
            <label className="sr-only" htmlFor="sticky-feed-rank-window">Rank window</label>
            <select
              id="sticky-feed-rank-window"
              value={config.column}
              onChange={event =>
                updateConfig({ column: event.target.value as typeof config.column })
              }
              className={SELECT_CLASS}
              title="Top 5 rank window"
            >
              {STICKY_FEED_RANK_WINDOWS.map(window => (
                <option key={window.id} value={window.id}>
                  Top 5 by {window.label}
                </option>
              ))}
            </select>
          </div>
          <div className={SELECT_WRAP_CLASS}>
            <label className="sr-only" htmlFor="sticky-feed-sort-interval">Sort interval</label>
            <select
              id="sticky-feed-sort-interval"
              value={config.sortIntervalMs}
              onChange={event =>
                updateConfig({ sortIntervalMs: Number(event.target.value) })
              }
              className={SELECT_CLASS}
              title="How often top-5 order re-sorts (live % still updates every second)"
            >
              {STICKY_FEED_SORT_INTERVALS.map(option => (
                <option key={option.ms} value={option.ms}>
                  Sort {option.label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={() => updateConfig({ expanded: false })}
            className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-slate-300/25 bg-card text-text-secondary transition-colors hover:border-slate-300/45 hover:text-text-primary"
            title="Collapse sticky feed"
          >
            <ChevronUp className="h-4 w-4" />
          </button>
        </div>
      </div>
      </div>
    </>
  )
}
