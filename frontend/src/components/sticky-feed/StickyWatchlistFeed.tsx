import { useCallback, useEffect, useState, type MouseEvent } from 'react'
import { ChevronDown, ChevronUp, ListOrdered, Timer, Zap } from 'lucide-react'
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
import {
  loadWatchlistChromeHidden,
  WL_CHROME_HIDDEN_CHANGED_EVENT,
} from '../../lib/watchlistChromeHidden'
import type { WindowChangesLookup } from '../../lib/watchlistAutoSort'
import type { WatchlistChangeWindowId } from '../../lib/watchlistChangeColumns'
import type { RankedWatchlistSymbol } from '../../lib/watchlistTopPerformers'

const STICKY_BAR_CLASS =
  'shrink-0 border-b border-border bg-secondary/70 backdrop-blur-xl'
const SELECT_WRAP_CLASS =
  'inline-flex h-9 items-center gap-1 rounded-md border border-border bg-card pl-2 shadow-sm transition-colors focus-within:border-accent/40'
const SELECT_CLASS =
  'h-9 cursor-pointer border-0 bg-transparent pl-0.5 pr-6 text-xs font-semibold text-text-primary outline-none [color-scheme:dark]'

const ACTION_CELL_BASE =
  'flex h-full min-w-[2.5rem] items-center justify-center rounded-md border text-sm font-bold transition-colors'
const DEMO_CELL =
  'border-green/25 bg-green/10 text-green hover:bg-green/20'
const DEMO_CELL_ACTIVE = 'border-green/50 bg-green/20 text-green ring-1 ring-inset ring-green/40'
const LIVE_CELL =
  'border-red/25 bg-red/10 text-red hover:bg-red/20'
const LIVE_CELL_ACTIVE = 'border-red/50 bg-red/20 text-red ring-1 ring-inset ring-red/40'
const MOMENTUM_TP_CELL =
  'border-accent/25 bg-accent/10 text-accent hover:bg-accent/20'
const MOMENTUM_TP_CELL_ACTIVE = 'border-accent/50 bg-accent/20 text-accent ring-1 ring-inset ring-accent/45'
const MOMENTUM_NO_TP_CELL =
  'border-accent-2/25 bg-accent-2/10 text-accent-2 hover:bg-accent-2/20'
const MOMENTUM_NO_TP_CELL_ACTIVE = 'border-accent-2/50 bg-accent-2/20 text-accent-2 ring-1 ring-inset ring-accent-2/45'

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
      className="flex h-[4.25rem] min-w-[13rem] shrink-0 overflow-hidden rounded-lg border border-border bg-card/80 shadow-panel ring-1 ring-inset ring-white/[0.02]"
      title={`${label} · ${row.watchlistName}`}
    >
      <Link
        to="/watchlist"
        className="flex min-w-0 flex-1 flex-col justify-center border-r border-border/70 px-3 transition-colors hover:bg-card-hi"
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
        className="w-full max-w-sm overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="border-b border-border px-5 py-4">
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
                    ? 'border border-red/30 bg-red/15 text-red'
                    : 'border border-green/30 bg-green/15 text-green'
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

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border px-3 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-card-hi hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onApprove}
            autoFocus
            className="rounded-md bg-green px-4 py-2 text-sm font-bold text-primary shadow-[0_4px_14px_rgb(var(--c-up)/0.3)] transition-colors hover:brightness-110"
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
  const [chromeHidden, setChromeHidden] = useState(() => loadWatchlistChromeHidden())

  useEffect(() => {
    const sync = () => setChromeHidden(loadWatchlistChromeHidden())
    window.addEventListener(WL_CHROME_HIDDEN_CHANGED_EVENT, sync)
    return () => window.removeEventListener(WL_CHROME_HIDDEN_CHANGED_EVENT, sync)
  }, [])

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

  if (!hasSymbols || chromeHidden) return null

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
        <div className="flex h-full min-h-0 min-w-0 flex-1 items-center gap-2.5 overflow-x-auto px-2.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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

        <div className="flex h-full shrink-0 items-center gap-2 self-stretch px-3">
          <div className={SELECT_WRAP_CLASS}>
            <ListOrdered className="h-3.5 w-3.5 shrink-0 text-accent" />
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
                  {window.label}
                </option>
              ))}
            </select>
          </div>
          <div className={SELECT_WRAP_CLASS}>
            <Timer className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
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
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={() => updateConfig({ expanded: false })}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-card text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
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
