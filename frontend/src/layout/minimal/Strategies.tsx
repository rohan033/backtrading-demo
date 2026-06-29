import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LineData,
} from 'lightweight-charts'
import './Strategies.css'
import LiveLogPanel from '../../components/LiveLogPanel'
import type { StrategyTableRow } from '../../components/StrategiesTable'
import {
  CreateExecutionPanel,
  ExecutionProvider,
  buildChartSeries,
  getPlaneStream,
  resolveExecutionStream,
  startControlledExecution,
  unscheduleControlledExecution,
  useExecution,
} from '../../ExecutionWorkspace'
import { useWatchlistStream } from '../../context/WatchlistStreamContext'
import { executionsToStrategyRows } from '../../lib/strategyRows'
import { resolveExecutionSourceId, resolveExecutionSourceMetaId } from '../../lib/executionSources'
import { formatDbTimestamp, parseDbTimestamp } from '../../lib/datetime'
import { formatScheduledStart, scheduleSummary } from '../../lib/tradingSchedule'
import { findWatchlistFeedMatch, buildWatchlistLinePoints, resolveWatchlistSymbolRef } from '../../lib/watchlistFeedReuse'
import {
  fetchWatchlistSymbolCandles,
  mergePriceSamples,
  ohlcCandlesToPriceSamples,
  WATCHLIST_CHART_INITIAL_COUNT,
  type WatchlistSanitizedCandle,
} from '../../lib/watchlistCandles'
import type { WatchlistChartSymbol } from '../../lib/watchlistUniqueSymbols'
import { mergeActivityEvents, type ActivityItem } from '../../lib/tradingActivity'
import { computeLivePnl, formatPnl } from '../../lib/positionPnl'
import {
  closeExecutionPosition,
  loadExecutionPositions,
  type ExecutionPositionRow,
} from '../../lib/executionPositions'
import { watchlistTickKey, type Watchlist } from '../../lib/watchlists'
import { useUrlState } from './useUrlState'

const CONTROL_API = '/api/control'
const DEFAULT_STRATEGY_CHART_HEIGHT = 340
const MIN_STRATEGY_CHART_HEIGHT = 120
const MAX_STRATEGY_CHART_HEIGHT = 560

function formatShortCreated(raw: string): string {
  const date = parseDbTimestamp(raw)
  if (!date) return ''
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function compactActivityText(item: ActivityItem): string {
  const title = item.title.trim()
  const detail = item.detail?.trim()
  if (!detail || detail === 'Strategy event') return title

  const parts = detail.split(' · ').map(part => part.trim()).filter(Boolean)
  const orderIdx = parts.findIndex(part => /^order\s+\d+/i.test(part))
  const orderPart = orderIdx >= 0 ? parts[orderIdx] : null
  const tailParts = orderIdx >= 0 ? parts.slice(orderIdx + 1) : parts.filter(part => !/^order\s+\d+/i.test(part))
  const tail = tailParts.length ? ` · ${tailParts.join(' · ')}` : ''

  if (orderPart && /order/i.test(title)) {
    const base = title.replace(/\s·\s*[A-Z0-9.-]+$/i, '').trim()
    const orderNum = orderPart.replace(/^order\s+/i, '')
    return `${base} · #${orderNum}${tail}`
  }

  if (detail.includes(title) || title.includes(detail)) return detail
  return `${title} · ${detail}`
}

function resolveExecutionChartSymbol(
  watchlists: Watchlist[],
  execution: Record<string, unknown>,
): WatchlistChartSymbol | null {
  const ref = resolveWatchlistSymbolRef(watchlists, {
    broker: execution.broker as string,
    account_env: execution.account_env as string,
    token: execution.token as string,
    symbol: execution.symbol as string,
  })
  if (!ref) return null

  for (const watchlist of watchlists) {
    const wlBroker = (watchlist.broker || 'angel').toLowerCase() === 'etoro' ? 'etoro' : 'angel'
    const wlEnv = watchlist.account_env || (wlBroker === 'etoro' ? 'demo' : 'live')
    if (wlBroker !== ref.broker || wlEnv !== ref.accountEnv) continue

    for (const symbol of watchlist.symbols) {
      if (symbol.symboltoken !== ref.symboltoken) continue
      return {
        tickKey: watchlistTickKey(ref.broker, ref.accountEnv, ref.symboltoken),
        watchlistId: watchlist.id,
        broker: ref.broker,
        accountEnv: ref.accountEnv,
        symboltoken: ref.symboltoken,
        tradingsymbol: symbol.tradingsymbol || symbol.symbol || String(execution.symbol || ''),
        exchange: symbol.exchange || '',
      }
    }
  }
  return null
}

function fitChartZoomedOut(chart: IChartApi) {
  const timeScale = chart.timeScale()
  timeScale.fitContent()
  const range = timeScale.getVisibleLogicalRange()
  if (!range) return
  const span = Math.max(range.to - range.from, 24)
  timeScale.setVisibleLogicalRange({
    from: range.from - span * 0.45,
    to: range.to + span * 0.12,
  })
}

type StrategyFilter = 'all' | 'running' | 'scheduled' | 'stopped'

type LogTarget = {
  id: string
  label: string
  logFile: string | null
}

type SymbolVisual = {
  ticker: string
  logo35x35?: string | null
  logo50x50?: string | null
  logo150x150?: string | null
}

function symbolLookupKeys(symbol: string) {
  const raw = symbol.trim().toUpperCase()
  if (!raw) return []
  const keys = new Set<string>([raw])
  keys.add(raw.replace(/\.US$/i, ''))
  return [...keys]
}

function buildSymbolVisualMap(watchlists: Watchlist[]) {
  const map = new Map<string, SymbolVisual>()
  for (const watchlist of watchlists) {
    for (const symbol of watchlist.symbols) {
      const ticker = symbol.tradingsymbol || symbol.symbol || ''
      const visual: SymbolVisual = {
        ticker: ticker || symbol.symbol,
        logo35x35: symbol.logo35x35,
        logo50x50: symbol.logo50x50,
        logo150x150: symbol.logo150x150,
      }
      for (const key of symbolLookupKeys(ticker || symbol.symbol)) {
        if (!map.has(key)) map.set(key, visual)
      }
    }
  }
  return map
}

function lookupSymbolVisual(map: Map<string, SymbolVisual>, symbol: string): SymbolVisual | null {
  for (const key of symbolLookupKeys(symbol)) {
    const hit = map.get(key)
    if (hit) return hit
  }
  return null
}

function SymbolLogo({
  symbol,
  visual,
  size = 'small',
}: {
  symbol: string
  visual?: SymbolVisual | null
  size?: 'small' | 'large'
}) {
  const [failed, setFailed] = useState(false)
  const ticker = visual?.ticker || symbol
  const src = size === 'large'
    ? (visual?.logo150x150 || visual?.logo50x50 || visual?.logo35x35)
    : (visual?.logo35x35 || visual?.logo50x50 || visual?.logo150x150)

  if (src && !failed) {
    return (
      <img
        src={src}
        alt={ticker}
        className={size === 'large' ? 'st-symbol-logo st-symbol-logo--large' : 'st-symbol-logo'}
        onError={() => setFailed(true)}
      />
    )
  }

  return (
    <span className={size === 'large' ? 'st-symbol-letter st-symbol-letter--large' : 'st-symbol-letter'}>
      {(ticker || '?').charAt(0)}
    </span>
  )
}

const MIN_PAGE_SIZE = 8
const DEFAULT_PAGE_SIZE = 25
const ROW_HEIGHT_PX = 27
const TABLE_HEADER_PX = 31
const PAGINATION_RESERVE_PX = 34

function useListPageSize(
  listBlockRef: React.RefObject<HTMLDivElement | null>,
  rowCount: number,
) {
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)

  useEffect(() => {
    const node = listBlockRef.current
    if (!node) return

    const measure = () => {
      const sampleRow = node.querySelector('.st-table-row')
      const rowHeight = sampleRow?.getBoundingClientRect().height || ROW_HEIGHT_PX
      const headerHeight = node.querySelector('.st-thead-row')?.getBoundingClientRect().height || TABLE_HEADER_PX
      const paginationHeight = node.querySelector('.st-pagination')?.getBoundingClientRect().height || 0
      const paginationReserve = paginationHeight > 0 ? paginationHeight + 6 : PAGINATION_RESERVE_PX
      const available = node.clientHeight - paginationReserve
      const rowsThatFit = Math.floor((available - headerHeight) / rowHeight)
      setPageSize(Math.max(MIN_PAGE_SIZE, rowsThatFit))
    }

    measure()
    const raf = requestAnimationFrame(measure)
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [listBlockRef, rowCount])

  return pageSize
}

const FILTER_OPTIONS: { id: StrategyFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'stopped', label: 'Stopped' },
]

function strategyTitle(execution: Record<string, unknown> | null | undefined) {
  if (!execution) return 'Strategy'
  const symbol = execution.symbol || '—'
  const pct = execution.long_percent != null ? `${execution.long_percent}%` : ''
  const template = execution.strategy_name === 'one-percent'
    ? 'Breakout'
    : (execution.strategy_name || 'Strategy')
  return [symbol, pct, template].filter(Boolean).join(' ')
}

function envLabel(env: unknown) {
  return String(env || 'live').toLowerCase() === 'demo' ? 'Demo' : 'Live'
}

function statusBadgeKind(status: string, isLive: boolean) {
  if (isLive) return 'running'
  if (status === 'scheduled') return 'scheduled'
  return 'stopped'
}

function statusBadgeText(status: string, isLive: boolean) {
  if (isLive) {
    if (status === 'starting') return 'Starting'
    if (status === 'stale') return 'Stale'
    return 'Running'
  }
  if (status === 'scheduled') return 'Scheduled'
  return status.replace(/_/g, ' ') || 'Stopped'
}

function StatusBadge({
  kind,
  children,
}: {
  kind: 'running' | 'scheduled' | 'stopped' | 'draft' | 'demo' | 'live'
  children: React.ReactNode
}) {
  return <span className={`st-badge st-badge--${kind}`}>{children}</span>
}

function filterExecutions(
  executions: ReturnType<typeof useExecution>['panelExecutions'],
  filter: StrategyFilter,
) {
  return executions.filter(execution => {
    const engineStatus = String(execution.data_plane_status || execution.status || 'unknown').toLowerCase()
    const isStoppable = ['running', 'starting', 'stale'].includes(engineStatus)
    const isScheduled = engineStatus === 'scheduled'
    if (filter === 'running') return isStoppable
    if (filter === 'scheduled') return isScheduled
    if (filter === 'stopped') return !isStoppable && !isScheduled
    return true
  })
}

function BulkStopButton({
  count,
  onComplete,
}: {
  count: number
  onComplete: () => void | Promise<void>
}) {
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState('')

  const stopAll = async () => {
    if (stopping || count < 1) return
    if (!window.confirm(`Stop all ${count} running strateg${count === 1 ? 'y' : 'ies'}?`)) return
    setStopping(true)
    setError('')
    try {
      const res = await fetch('/api/control/executions/stop-all', { method: 'POST' })
      const payload = await res.json()
      if (!res.ok || !payload.status) {
        throw new Error(payload.detail || payload.message || 'Failed to stop strategies')
      }
      await onComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop strategies')
    } finally {
      setStopping(false)
    }
  }

  return (
    <div>
      <button
        type="button"
        className="st-btn st-btn--danger"
        disabled={stopping || count < 1}
        onClick={() => void stopAll()}
      >
        {stopping ? 'Stopping…' : count > 0 ? `Stop all (${count})` : 'Stop all'}
      </button>
      {error ? <div className="st-status-msg st-status-msg--error">{error}</div> : null}
    </div>
  )
}

function BulkUnscheduleButton({
  count,
  onComplete,
}: {
  count: number
  onComplete: () => void | Promise<void>
}) {
  const [unscheduling, setUnscheduling] = useState(false)
  const [error, setError] = useState('')

  const unscheduleAll = async () => {
    if (unscheduling || count < 1) return
    if (!window.confirm(`Unschedule all ${count} scheduled strateg${count === 1 ? 'y' : 'ies'}?`)) return
    setUnscheduling(true)
    setError('')
    try {
      const res = await fetch('/api/control/executions/bulk/unschedule', { method: 'POST' })
      const payload = await res.json()
      if (!res.ok || !payload.status) {
        throw new Error(payload.detail || payload.message || 'Failed to unschedule strategies')
      }
      await onComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unschedule strategies')
    } finally {
      setUnscheduling(false)
    }
  }

  return (
    <div>
      <button
        type="button"
        className="st-btn st-btn--accent"
        disabled={unscheduling || count < 1}
        onClick={() => void unscheduleAll()}
      >
        {unscheduling ? 'Unscheduling…' : count > 0 ? `Unschedule all (${count})` : 'Unschedule all'}
      </button>
      {error ? <div className="st-status-msg st-status-msg--error">{error}</div> : null}
    </div>
  )
}

function formatRowWhen(row: StrategyTableRow) {
  const raw = row.scheduledFor || row.createdAt
  const date = parseDbTimestamp(raw)
  if (!date) return '—'
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function StrategyTableRow({
  row,
  visual,
  selected,
  onSelect,
  onLogs,
}: {
  row: StrategyTableRow & { isLive?: boolean; isScheduled?: boolean }
  visual: SymbolVisual | null
  selected: boolean
  onSelect: (id: string) => void
  onLogs: (target: LogTarget) => void
}) {
  const status = row.status.toLowerCase()
  const statusKind = statusBadgeKind(status, Boolean(row.isLive))
  const env = String(row.accountEnv || 'live').toLowerCase()

  return (
    <tr
      className={`st-table-row ${selected ? 'st-table-row--selected' : ''}`}
      onClick={() => onSelect(row.id)}
    >
      <td className="st-td st-td--sym">
        <div className="st-sym-cell">
          <span className="st-sym-icon">
            <SymbolLogo symbol={row.symbol} visual={visual} />
          </span>
          <span className="st-ticker">{row.symbol}</span>
        </div>
      </td>
      <td className="st-td st-td--name" title={row.name}>
        {row.name}
      </td>
      <td className={`st-td st-td-status st-td-status--${statusKind}`}>
        {statusBadgeText(status, Boolean(row.isLive))}
      </td>
      <td className={`st-td st-td-env ${env === 'demo' ? 'st-td-env--demo' : ''}`}>
        {envLabel(row.accountEnv)}
      </td>
      <td className="st-td st-td-when">{formatRowWhen(row)}</td>
      <td className="st-td st-td-action">
        <button
          type="button"
          className="st-log-link"
          onClick={event => {
            event.stopPropagation()
            onLogs({ id: row.id, label: row.name, logFile: row.logFile || null })
          }}
        >
          Logs
        </button>
      </td>
    </tr>
  )
}

function StrategiesPagination({
  page,
  pageCount,
  onPageChange,
}: {
  page: number
  pageCount: number
  onPageChange: (page: number) => void
}) {
  if (pageCount <= 1) return null

  return (
    <div className="st-pagination">
      <button
        type="button"
        className="st-page-btn"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        Prev
      </button>
      <span className="st-page-indicator">{page}/{pageCount}</span>
      <button
        type="button"
        className="st-page-btn"
        disabled={page >= pageCount}
        onClick={() => onPageChange(page + 1)}
      >
        Next
      </button>
    </div>
  )
}

function StrategiesTable({
  rows,
  symbolVisuals,
  selectedId,
  onSelect,
  onLogs,
}: {
  rows: Array<StrategyTableRow & { isLive?: boolean; isScheduled?: boolean }>
  symbolVisuals: Map<string, SymbolVisual>
  selectedId: string | null
  onSelect: (id: string) => void
  onLogs: (target: LogTarget) => void
}) {
  return (
    <div className="st-table-scroll">
      <div className="st-table-card">
        <table className="st-table">
          <colgroup>
            <col className="st-col-sym" />
            <col className="st-col-name" />
            <col className="st-col-status" />
            <col className="st-col-env" />
            <col className="st-col-when" />
            <col className="st-col-action" />
          </colgroup>
          <thead>
            <tr className="st-thead-row">
              <th className="st-th">Symbol</th>
              <th className="st-th">Strategy</th>
              <th className="st-th">Status</th>
              <th className="st-th">Env</th>
              <th className="st-th">When</th>
              <th className="st-th st-th-action" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <StrategyTableRow
                key={row.id}
                row={row}
                visual={lookupSymbolVisual(symbolVisuals, row.symbol)}
                selected={selectedId === row.id}
                onSelect={onSelect}
                onLogs={onLogs}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function StrategyDetailEmpty() {
  return (
    <div className="st-detail-wrap">
      <div className="st-detail st-detail--empty">
        <span>Select a strategy</span>
      </div>
    </div>
  )
}

function StrategyMiniChart({
  execution,
  planeStreams,
  selectedTick,
  height,
}: {
  execution: Record<string, unknown>
  planeStreams: ReturnType<typeof useExecution>['planeStreams']
  selectedTick: ReturnType<typeof useExecution>['selectedTick']
  height: number
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const lineRef = useRef<ISeriesApi<'Line'> | null>(null)
  const userInteractedRef = useRef(false)
  const lastAutoFitKeyRef = useRef<string | null>(null)
  const [candles, setCandles] = useState<WatchlistSanitizedCandle[]>([])
  const [loadedCandleKey, setLoadedCandleKey] = useState<string | null>(null)
  const { watchlists, ticks, connected, historyRef } = useWatchlistStream()

  const chartSymbol = useMemo(
    () => resolveExecutionChartSymbol(watchlists, execution),
    [watchlists, execution],
  )

  const stream = getPlaneStream(planeStreams, execution?.data_plane_id as string | undefined)
  const resolvedStream = useMemo(
    () => resolveExecutionStream(stream, execution),
    [stream, execution],
  )
  const watchlistFeed = useMemo(
    () => (connected
      ? findWatchlistFeedMatch(watchlists, ticks, historyRef, {
          broker: execution.broker as string,
          account_env: execution.account_env as string,
          token: execution.token as string,
          symbol: execution.symbol as string,
        })
      : null),
    [execution, connected, watchlists, ticks, historyRef],
  )
  const ltp = selectedTick?.ltp ?? resolvedStream.tick?.ltp ?? watchlistFeed?.tick?.ltp ?? null
  const lineData = useMemo(() => {
    const toLine = (points: Array<{ time: number; value: number }>): LineData[] => (
      points.map(point => ({ time: point.time as LineData['time'], value: point.value }))
    )

    if (candles.length > 0) {
      const mergedSamples = mergePriceSamples(
        ohlcCandlesToPriceSamples(candles),
        watchlistFeed?.samples ?? [],
      )
      const fromCandles = buildWatchlistLinePoints(mergedSamples, ltp)
      if (fromCandles.length > 0) return toLine(fromCandles)
    }

    if (resolvedStream.tickHistory.length > 0) {
      const series = buildChartSeries(resolvedStream.tickHistory, execution, ltp) as Array<{ time: number; value: number }>
      if (series.length > 1 && series.every(point => point.value === series[0].value)) {
        return toLine([series[series.length - 1]])
      }
      return toLine(series)
    }

    const watchlistPoints = buildWatchlistLinePoints(watchlistFeed?.samples ?? [], ltp)
    if (watchlistPoints.length > 0) return toLine(watchlistPoints)

    return toLine(buildChartSeries([], execution, ltp) as Array<{ time: number; value: number }>)
  }, [candles, resolvedStream.tickHistory, execution, ltp, watchlistFeed?.samples])

  const chartKey = chartSymbol?.tickKey
    || String(execution.executor_id || execution.data_plane_id || execution.symbol || 'chart')

  useEffect(() => {
    if (!chartSymbol || loadedCandleKey === chartSymbol.tickKey) return
    let cancelled = false
    fetchWatchlistSymbolCandles(chartSymbol, WATCHLIST_CHART_INITIAL_COUNT)
      .then(next => {
        if (cancelled) return
        setCandles(next)
        setLoadedCandleKey(chartSymbol.tickKey)
      })
      .catch(() => {
        if (!cancelled) {
          setCandles([])
          setLoadedCandleKey(chartSymbol.tickKey)
        }
      })
    return () => { cancelled = true }
  }, [chartSymbol, loadedCandleKey])

  useEffect(() => {
    setCandles([])
    setLoadedCandleKey(null)
  }, [chartKey])

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    userInteractedRef.current = false
    lastAutoFitKeyRef.current = null
    const chart = createChart(el, {
      width: Math.max(1, el.clientWidth),
      height: Math.max(80, height),
      attributionLogo: false,
      layout: { background: { color: '#FFFFFF' }, textColor: '#9A9A9A' },
      grid: {
        vertLines: { color: '#F1F1F1' },
        horzLines: { color: '#F1F1F1' },
      },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.12 } },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
        barSpacing: 3,
        minBarSpacing: 0.5,
      },
      crosshair: { mode: 0 },
    })
    chartRef.current = chart
    lineRef.current = null
    const resize = () => chart.applyOptions({
      width: Math.max(1, el.clientWidth),
      height: Math.max(80, height),
    })
    const observer = new ResizeObserver(resize)
    observer.observe(el)
    const markUserInteracted = () => { userInteractedRef.current = true }
    el.addEventListener('wheel', markUserInteracted, { passive: true })
    el.addEventListener('pointerdown', markUserInteracted)
    return () => {
      el.removeEventListener('wheel', markUserInteracted)
      el.removeEventListener('pointerdown', markUserInteracted)
      observer.disconnect()
      chart.remove()
      chartRef.current = null
      lineRef.current = null
    }
  }, [height, chartKey])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    if (!lineRef.current) {
      lineRef.current = chart.addLineSeries({
        color: '#2F80ED',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
      })
    }
    lineRef.current.setData(lineData)
    const autoFitKey = `${chartKey}:line:${lineData.length}`
    if (lineData.length && !userInteractedRef.current && lastAutoFitKeyRef.current !== autoFitKey) {
      fitChartZoomedOut(chart)
      lastAutoFitKeyRef.current = autoFitKey
    }
  }, [lineData, chartKey])

  return (
    <div className="st-mini-chart">
      <div ref={hostRef} className="st-mini-chart-host" />
      {!lineData.length ? <span className="st-chart-label">waiting for live price</span> : null}
    </div>
  )
}

type DetailBottomTab = 'activity' | 'positions'

function StrategyCompactPositions({
  executorId,
  livePrice,
  liveApi,
  broker,
  accountEnv,
  symbol,
  token,
  realtimeEvents,
  onChanged,
  onOpenCountChange,
}: {
  executorId: string
  livePrice: number | null
  liveApi?: string | null
  broker?: string | null
  accountEnv?: string | null
  symbol?: string | null
  token?: string | number | null
  realtimeEvents: Record<string, unknown>[]
  onChanged?: () => void
  onOpenCountChange?: (count: number) => void
}) {
  const [positions, setPositions] = useState<ExecutionPositionRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busyPositionId, setBusyPositionId] = useState<string | number | null>(null)

  const loadPositions = useCallback(async () => {
    if (!executorId) {
      setPositions([])
      onOpenCountChange?.(0)
      return
    }
    setLoading(true)
    setError('')
    try {
      const rows = await loadExecutionPositions({
        executorId,
        liveApi,
        broker,
        accountEnv,
        symbol,
        token,
      })
      setPositions(rows)
      onOpenCountChange?.(rows.length)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load positions')
      setPositions([])
      onOpenCountChange?.(0)
    } finally {
      setLoading(false)
    }
  }, [executorId, liveApi, broker, accountEnv, symbol, token, onOpenCountChange])

  useEffect(() => {
    void loadPositions()
    const id = window.setInterval(() => { void loadPositions() }, 10_000)
    return () => window.clearInterval(id)
  }, [loadPositions, realtimeEvents.length])

  const closePosition = async (row: ExecutionPositionRow) => {
    setBusyPositionId(row.position_id)
    setError('')
    try {
      await closeExecutionPosition(executorId, row)
      onChanged?.()
      await loadPositions()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to close position')
    } finally {
      setBusyPositionId(null)
    }
  }

  if (loading && !positions.length) {
    return <div className="st-detail-tab-empty">Loading positions…</div>
  }

  if (error && !positions.length) {
    return (
      <div className="st-detail-tab-empty">
        <span>{error}</span>
        <button type="button" className="st-detail-tab-retry" onClick={() => void loadPositions()}>
          Retry
        </button>
      </div>
    )
  }

  if (!positions.length) {
    return <div className="st-detail-tab-empty">No open positions</div>
  }

  return (
    <div className="st-detail-tab-scroll">
      {error ? <div className="st-pos-error">{error}</div> : null}
      {positions.map(row => {
        const position = row.position || {}
        const positionId = row.position_id
        const units = row.remaining_units ?? position.remainingUnits ?? null
        const live = computeLivePnl(row, livePrice)
        const pnlLabel = live ? formatPnl(live.pnl) : null
        const unitsLabel = units != null ? Number(units).toFixed(3) : '—'
        const prefix = row.source === 'live' ? 'Order' : 'Position'
        const statusSuffix = row.statusLabel ? ` · ${row.statusLabel}` : ''

        return (
          <div key={String(positionId)} className="st-pos-row">
            <span className="st-pos-main">
              {prefix} #{row.order_id ?? positionId} · {unitsLabel} units
              {pnlLabel ? ` · ${pnlLabel}` : ''}
              {statusSuffix}
            </span>
            {row.closable ? (
              <button
                type="button"
                className="st-pos-close"
                disabled={busyPositionId === positionId}
                onClick={() => void closePosition(row)}
              >
                {busyPositionId === positionId ? 'Closing…' : 'Close'}
              </button>
            ) : (
              <span className="st-pos-note">Awaiting broker fill</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

function StrategyDetailBottomPanel({
  executorId,
  realtimeEvents,
  livePrice,
  liveApi,
  broker,
  accountEnv,
  symbol,
  token,
  onPositionsChanged,
}: {
  executorId: string
  realtimeEvents: Record<string, unknown>[]
  livePrice: number | null
  liveApi?: string | null
  broker?: string | null
  accountEnv?: string | null
  symbol?: string | null
  token?: string | number | null
  onPositionsChanged?: () => void
}) {
  const [tab, setTab] = useState<DetailBottomTab>('activity')
  const [openCount, setOpenCount] = useState(0)

  useEffect(() => {
    if (!executorId) {
      setOpenCount(0)
      return
    }
    loadExecutionPositions({ executorId, liveApi, broker, accountEnv, symbol, token })
      .then(rows => setOpenCount(rows.length))
      .catch(() => setOpenCount(0))
  }, [executorId, liveApi, broker, accountEnv, symbol, token, realtimeEvents.length])

  return (
    <div className="st-detail-tabs">
      <div className="st-detail-tab-bar">
        <button
          type="button"
          className={`st-detail-tab${tab === 'activity' ? ' st-detail-tab--active' : ''}`}
          onClick={() => setTab('activity')}
        >
          Activity
        </button>
        <button
          type="button"
          className={`st-detail-tab${tab === 'positions' ? ' st-detail-tab--active' : ''}`}
          onClick={() => setTab('positions')}
        >
          Positions{openCount > 0 ? ` (${openCount})` : ''}
        </button>
      </div>
      <div className="st-detail-tab-panel">
        {tab === 'activity' ? (
          <StrategyCompactActivity
            executorId={executorId}
            realtimeEvents={realtimeEvents}
          />
        ) : (
          <StrategyCompactPositions
            executorId={executorId}
            livePrice={livePrice}
            liveApi={liveApi}
            broker={broker}
            accountEnv={accountEnv}
            symbol={symbol}
            token={token}
            realtimeEvents={realtimeEvents}
            onChanged={onPositionsChanged}
            onOpenCountChange={setOpenCount}
          />
        )}
      </div>
    </div>
  )
}

function StrategyCompactActivity({
  executorId,
  realtimeEvents,
}: {
  executorId: string
  realtimeEvents: Record<string, unknown>[]
}) {
  const [persistedEvents, setPersistedEvents] = useState<Record<string, unknown>[]>([])

  useEffect(() => {
    const params = new URLSearchParams({ limit: '40', executor_id: executorId })
    fetch(`${CONTROL_API}/events?${params}`)
      .then(res => res.json())
      .then(data => {
        if (data.status) setPersistedEvents(data.data || [])
      })
      .catch(() => setPersistedEvents([]))
  }, [executorId, realtimeEvents.length])

  const events = useMemo(
    () => mergeActivityEvents(realtimeEvents, persistedEvents, { executorId, limit: 40 }),
    [realtimeEvents, persistedEvents, executorId],
  )

  return (
    <div className="st-detail-tab-scroll">
      {events.length ? events.map((item, index) => (
        <div
          key={`${item.title}-${index}`}
          className={`st-act-row st-act-row--${item.type}`}
          title={compactActivityText(item)}
        >
          <span className="st-act-dot" aria-hidden />
          <span className="st-act-text">{compactActivityText(item)}</span>
          <span className="st-act-time">{item.time}</span>
        </div>
      )) : (
        <div className="st-detail-tab-empty">No recent activity</div>
      )}
    </div>
  )
}

function StrategyDetailPanel({
  executionId,
  symbolVisuals,
  onClose,
}: {
  executionId: string
  symbolVisuals: Map<string, SymbolVisual>
  onClose: () => void
}) {
  const [stopping, setStopping] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const [unscheduling, setUnscheduling] = useState(false)
  const [actionError, setActionError] = useState('')
  const [logOpen, setLogOpen] = useState(false)
  const [chartHeight, setChartHeight] = useState(DEFAULT_STRATEGY_CHART_HEIGHT)
  const chartResizingRef = useRef(false)

  const handleChartResizeStart = (e: ReactMouseEvent) => {
    e.preventDefault()
    chartResizingRef.current = true
    const startY = e.clientY
    const startH = chartHeight
    const onMove = (ev: MouseEvent) => {
      if (!chartResizingRef.current) return
      setChartHeight(Math.max(
        MIN_STRATEGY_CHART_HEIGHT,
        Math.min(MAX_STRATEGY_CHART_HEIGHT, startH + (ev.clientY - startY)),
      ))
    }
    const onUp = () => {
      chartResizingRef.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const {
    panelExecutions,
    controlledExecutions,
    selectedExecutionLive,
    selectedExecution,
    setSelectedExecutionId,
    setSelectedLaunchId,
    planeStreams,
    selectedTick,
    executionEvents,
    refreshExecutions,
    duplicateExecution,
    onExecutionStarted,
    onExecutionStopped,
    refreshControlledExecutions,
  } = useExecution()

  useEffect(() => {
    const live = panelExecutions.find(ex => ex.executor_id === executionId)
    if (live) {
      setSelectedExecutionId(executionId)
      return
    }
    const queued = controlledExecutions.find(item => item.execution_id === executionId)
    if (queued) setSelectedLaunchId(executionId)
  }, [executionId, panelExecutions, controlledExecutions, setSelectedExecutionId, setSelectedLaunchId])

  const execution = selectedExecutionLive || selectedExecution
  const queuedItem = controlledExecutions.find(item => item.execution_id === executionId)
  const engineStatus = String(
    queuedItem?.engine?.status || execution?.data_plane_status || '',
  ).toLowerCase()
  const isLive = ['running', 'starting'].includes(engineStatus)

  const overviewExecution = useMemo(() => {
    const fromPanel = panelExecutions.find(ex => ex.executor_id === executionId)
    const base = fromPanel || execution || null
    const engine = queuedItem?.engine
    const sourceId = resolveExecutionSourceId(base, queuedItem)
    const sourceMetaId = resolveExecutionSourceMetaId(base, queuedItem)

    if (!base && !engine) return null

    const executorPayload = queuedItem?.executor || engine?.metadata?.executor_payload || {}

    if (!engine) {
      return base
        ? { ...executorPayload, ...base, source_id: sourceId, source_meta_id: sourceMetaId }
        : null
    }

    return {
      ...executorPayload,
      ...(base || {}),
      source_id: sourceId,
      source_meta_id: sourceMetaId,
      created_at: base?.created_at || engine.created_at,
      data_plane_id: base?.data_plane_id || engine.id,
      data_plane_port: base?.data_plane_port || engine.port,
      data_plane_status: base?.data_plane_status || engine.status,
      api_base_url: base?.api_base_url || engine.api_base_url,
      ws_url: base?.ws_url || engine.ws_url,
      log_file: base?.log_file || engine.metadata?.log_file,
      broker: base?.broker || engine.broker,
      symbol: base?.symbol || engine.symbol,
      token: base?.token || engine.token,
      account_env: base?.account_env || engine.account_env,
      strategy_name: base?.strategy_name || engine.strategy_name,
      executor_id: base?.executor_id || executionId,
    }
  }, [panelExecutions, executionId, execution, queuedItem])

  const strategyActivityEvents = useMemo(() => {
    return executionEvents.filter(event => {
      const execId = event.executor_id || event.details?.executor_id
      return execId === executionId
    })
  }, [executionEvents, executionId])

  const stopStrategy = async () => {
    setActionError('')
    setStopping(true)
    try {
      const res = await fetch(`/api/control/executions/${encodeURIComponent(executionId)}/stop`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Failed to stop strategy')
      await refreshControlledExecutions()
      await onExecutionStopped(executionId)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to stop strategy')
    } finally {
      setStopping(false)
    }
  }

  const deployStrategy = async () => {
    setActionError('')
    setDeploying(true)
    try {
      const { engine, executor } = await startControlledExecution(executionId)
      await refreshControlledExecutions()
      await onExecutionStarted(engine, executor)
      await refreshExecutions()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to deploy strategy')
    } finally {
      setDeploying(false)
    }
  }

  const unscheduleStrategy = async () => {
    setActionError('')
    setUnscheduling(true)
    try {
      await unscheduleControlledExecution(executionId)
      await refreshControlledExecutions()
      await refreshExecutions()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to unschedule strategy')
    } finally {
      setUnscheduling(false)
    }
  }

  const handleDuplicate = async () => {
    setActionError('')
    const item = queuedItem || { execution_id: executionId }
    const draft = await duplicateExecution(item)
    if (!draft) {
      setActionError('Could not duplicate this strategy. Refresh and try again.')
    }
  }

  if (!overviewExecution && !queuedItem) {
    return (
      <div className="st-detail-wrap">
        <div className="st-detail st-detail--empty">
          <span>Strategy not found</span>
          <button type="button" className="st-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    )
  }

  const canStop = isLive && ['running', 'starting', 'stale'].includes(engineStatus)
  const canDeploy = !isLive
  const isScheduled = engineStatus === 'scheduled'
  const scheduledStartAt = overviewExecution?.scheduled_start_at
    || queuedItem?.engine?.metadata?.scheduled_start_at
    || null
  const scheduleLabel = overviewExecution?.market_open_label
    || queuedItem?.engine?.metadata?.market_open_label
    || null
  const tradingDay = overviewExecution?.trading_day
    || queuedItem?.engine?.metadata?.trading_day
    || null
  const logFile = overviewExecution?.log_file || queuedItem?.engine?.metadata?.log_file || null
  const logEngineId = overviewExecution?.data_plane_id || queuedItem?.engine?.id || executionId
  const badgeKind = statusBadgeKind(engineStatus, isLive)
  const symbolVisual = overviewExecution?.symbol
    ? lookupSymbolVisual(symbolVisuals, String(overviewExecution.symbol))
    : null
  const scheduleHint = isScheduled && (scheduledStartAt || tradingDay)
    ? `${formatScheduledStart(scheduledStartAt)} · ${scheduleSummary(tradingDay, scheduleLabel)}`
    : null

  return (
    <>
      {logOpen ? (
        <>
          <button
            type="button"
            aria-label="Close live log panel"
            className="st-log-backdrop"
            onClick={() => setLogOpen(false)}
          />
          <LiveLogPanel
            target={{
              id: logEngineId,
              label: strategyTitle(overviewExecution),
              logFile,
              isControlled: true,
            }}
            onClose={() => setLogOpen(false)}
          />
        </>
      ) : null}

      <div className="st-detail-wrap">
        <div className="st-detail">
          <div className="st-detail-head">
            <div className="st-detail-head-main">
              <span className="st-sym-icon">
                <SymbolLogo
                  symbol={String(overviewExecution?.symbol || '—')}
                  visual={symbolVisual}
                />
              </span>
              <span
                className="st-detail-head-title"
                title={`${strategyTitle(overviewExecution)} · ${executionId}`}
              >
                {strategyTitle(overviewExecution)}
              </span>
              <StatusBadge kind={badgeKind}>{statusBadgeText(engineStatus, isLive)}</StatusBadge>
              {overviewExecution?.is_in_position ? (
                <StatusBadge kind="running">In position</StatusBadge>
              ) : null}
              {overviewExecution?.created_at ? (
                <span className="st-detail-head-meta">
                  {formatShortCreated(String(overviewExecution.created_at))}
                </span>
              ) : null}
              {scheduleHint ? (
                <span className="st-detail-head-meta" title={scheduleHint}>Scheduled</span>
              ) : null}
            </div>
            <div className="st-detail-head-actions">
              <button type="button" className="st-btn st-btn--compact" onClick={onClose}>Close</button>
              {canDeploy ? (
                <button
                  type="button"
                  className="st-btn st-btn--compact st-btn--primary"
                  disabled={deploying || stopping || unscheduling}
                  onClick={() => void deployStrategy()}
                >
                  {deploying ? 'Deploy…' : isScheduled ? 'Deploy now' : 'Deploy'}
                </button>
              ) : null}
              {isScheduled ? (
                <button
                  type="button"
                  className="st-btn st-btn--compact"
                  disabled={unscheduling || deploying || stopping}
                  onClick={() => void unscheduleStrategy()}
                >
                  {unscheduling ? 'Unsched…' : 'Unschedule'}
                </button>
              ) : null}
              {canStop ? (
                <button
                  type="button"
                  className="st-btn st-btn--compact st-btn--danger"
                  disabled={stopping || deploying || unscheduling}
                  onClick={() => void stopStrategy()}
                >
                  {stopping ? 'Stopping…' : 'Stop'}
                </button>
              ) : null}
              <button type="button" className="st-btn st-btn--compact st-btn--accent" onClick={() => setLogOpen(true)}>
                Logs
              </button>
              <button
                type="button"
                className="st-btn st-btn--compact"
                disabled={deploying || stopping}
                onClick={() => void handleDuplicate()}
              >
                Duplicate
              </button>
            </div>
          </div>
          {actionError ? <div className="st-detail-error">{actionError}</div> : null}

          <div className="st-detail-chart-box" style={{ height: chartHeight }}>
            <StrategyMiniChart
              execution={overviewExecution || {}}
              planeStreams={planeStreams}
              selectedTick={selectedTick}
              height={chartHeight}
            />
            <div
              className="st-chart-resize-handle"
              onMouseDown={handleChartResizeStart}
              title="Drag to resize chart"
            />
          </div>
          <StrategyDetailBottomPanel
            executorId={executionId}
            realtimeEvents={strategyActivityEvents}
            livePrice={selectedTick?.ltp ?? null}
            liveApi={overviewExecution?.api_base_url || queuedItem?.engine?.api_base_url || null}
            broker={overviewExecution?.broker || queuedItem?.engine?.broker || null}
            accountEnv={overviewExecution?.account_env || queuedItem?.engine?.account_env || null}
            symbol={overviewExecution?.symbol || queuedItem?.engine?.symbol || null}
            token={overviewExecution?.token || queuedItem?.engine?.token || null}
            onPositionsChanged={() => { void refreshExecutions() }}
          />
        </div>
      </div>
    </>
  )
}

function StrategyCreatePanel({
  onDone,
  onCancel,
}: {
  onDone: (executionId: string) => void
  onCancel: () => void
}) {
  const {
    duplicateDraft,
    setDuplicateDraft,
    setShowCreate,
    onExecutionCreated,
    onExecutionStarted,
  } = useExecution()

  useEffect(() => {
    setShowCreate(true)
    return () => setShowCreate(false)
  }, [setShowCreate])

  return (
    <div className="st-create">
      <div className="st-create-inner">
        <CreateExecutionPanel
          variant="minimal"
          duplicateDraft={duplicateDraft}
          onCreated={async executionId => {
            await onExecutionCreated(executionId)
            setDuplicateDraft(null)
            onDone(executionId)
          }}
          onStarted={async (engine, executor) => {
            await onExecutionStarted(engine, executor)
            const id = executor?.executor_id
            if (id) onDone(id)
          }}
          onCancel={() => {
            setDuplicateDraft(null)
            onCancel()
          }}
        />
      </div>
    </div>
  )
}

function StrategiesWorkspace() {
  const { state, navigate } = useUrlState()
  const [logTarget, setLogTarget] = useState<LogTarget | null>(null)
  const listBlockRef = useRef<HTMLDivElement>(null)
  const { watchlists } = useWatchlistStream()
  const symbolVisuals = useMemo(() => buildSymbolVisualMap(watchlists), [watchlists])
  const {
    panelExecutions,
    controlledExecutionsLoading,
    controlledExecutionsError,
    refreshControlledExecutions,
    duplicateDraft,
    setDuplicateDraft,
  } = useExecution()

  const filter: StrategyFilter = FILTER_OPTIONS.some(option => option.id === state.strategy_filter)
    ? (state.strategy_filter as StrategyFilter)
    : 'all'
  const symbolQuery = state.strategy_q || ''
  const selectedId = state.strategy_id || null
  const createMode = state.strategy_mode === 'create'

  useEffect(() => {
    void refreshControlledExecutions()
  }, [refreshControlledExecutions])

  useEffect(() => {
    if (duplicateDraft && !createMode) {
      navigate({
        tab: 'strategies',
        strategy_mode: 'create',
        strategy_id: undefined,
      })
    }
  }, [duplicateDraft, createMode, navigate])

  const filteredExecutions = useMemo(
    () => filterExecutions(panelExecutions, filter),
    [panelExecutions, filter],
  )
  const rows = useMemo(
    () => executionsToStrategyRows(filteredExecutions) as Array<StrategyTableRow & { isLive?: boolean; isScheduled?: boolean }>,
    [filteredExecutions],
  )

  const symbolFilteredRows = useMemo(() => {
    const query = symbolQuery.trim().toLowerCase()
    if (!query) return rows
    return rows.filter(row =>
      row.symbol.toLowerCase().includes(query)
      || row.name.toLowerCase().includes(query),
    )
  }, [rows, symbolQuery])

  const pageSize = useListPageSize(listBlockRef, symbolFilteredRows.length)

  const pageCount = Math.max(1, Math.ceil(symbolFilteredRows.length / pageSize))
  const rawPage = Number.parseInt(state.strategy_page || '1', 10)
  const currentPage = Math.min(
    Math.max(1, Number.isFinite(rawPage) ? rawPage : 1),
    pageCount,
  )

  const pagedRows = useMemo(() => {
    const start = (currentPage - 1) * pageSize
    return symbolFilteredRows.slice(start, start + pageSize)
  }, [symbolFilteredRows, currentPage, pageSize])

  useEffect(() => {
    const parsed = Number.parseInt(state.strategy_page || '1', 10)
    if (!Number.isFinite(parsed) || parsed < 1) return
    if (parsed > pageCount) {
      navigate({ strategy_page: pageCount <= 1 ? undefined : String(pageCount) }, { replace: true })
    }
  }, [pageCount, state.strategy_page, navigate])

  const counts = useMemo(() => {
    const allRows = executionsToStrategyRows(panelExecutions) as Array<{ isLive?: boolean; isScheduled?: boolean }>
    return {
      all: allRows.length,
      running: allRows.filter(row => row.isLive).length,
      scheduled: allRows.filter(row => row.isScheduled).length,
      stopped: allRows.filter(row => !row.isLive && !row.isScheduled).length,
    }
  }, [panelExecutions])

  const setFilter = (next: StrategyFilter) => {
    navigate({
      tab: 'strategies',
      strategy_filter: next === 'all' ? undefined : next,
      strategy_page: undefined,
      strategy_q: symbolQuery.trim() || undefined,
    })
  }

  const setSymbolQuery = (next: string) => {
    navigate({
      tab: 'strategies',
      strategy_q: next.trim() || undefined,
      strategy_page: undefined,
      strategy_filter: filter === 'all' ? undefined : filter,
    })
  }

  const setPage = (page: number) => {
    navigate({
      tab: 'strategies',
      strategy_page: page <= 1 ? undefined : String(page),
      strategy_filter: filter === 'all' ? undefined : filter,
      strategy_q: symbolQuery.trim() || undefined,
    })
  }

  const selectStrategy = (id: string) => {
    navigate({
      tab: 'strategies',
      strategy_id: id,
      strategy_mode: undefined,
      strategy_filter: filter === 'all' ? undefined : filter,
      strategy_q: symbolQuery.trim() || undefined,
      strategy_page: currentPage <= 1 ? undefined : String(currentPage),
    })
  }

  const openCreate = () => {
    navigate({ tab: 'strategies', strategy_mode: 'create', strategy_id: undefined })
  }

  const closeCreate = () => {
    setDuplicateDraft(null)
    navigate({ tab: 'strategies', strategy_mode: undefined })
  }

  const closeDetail = () => {
    navigate({ tab: 'strategies', strategy_id: undefined })
  }

  const handleCreateDone = (executionId: string) => {
    navigate({
      tab: 'strategies',
      strategy_id: executionId,
      strategy_mode: undefined,
    })
  }

  if (createMode) {
    return (
      <div className="st-root">
        <div className="st-toolbar">
          <span className="st-toolbar-title">New strategy</span>
          <div className="st-toolbar-spacer" />
          <button type="button" className="st-btn" onClick={closeCreate}>Back to list</button>
        </div>
        <StrategyCreatePanel onDone={handleCreateDone} onCancel={closeCreate} />
      </div>
    )
  }

  return (
    <div className="st-root">
      {logTarget ? (
        <>
          <button
            type="button"
            aria-label="Close live log panel"
            className="st-log-backdrop"
            onClick={() => setLogTarget(null)}
          />
          <LiveLogPanel
            target={{
              id: logTarget.id,
              label: logTarget.label,
              logFile: logTarget.logFile,
              isControlled: true,
            }}
            onClose={() => setLogTarget(null)}
          />
        </>
      ) : null}

      <div className="st-toolbar">
        <span className="st-toolbar-title">Strategies</span>
        <div className="st-filter-pills">
          {FILTER_OPTIONS.map(option => (
            <button
              key={option.id}
              type="button"
              className={`st-pill ${filter === option.id ? 'st-pill--active' : ''}`}
              onClick={() => setFilter(option.id)}
            >
              {option.label}
              <span className="st-pill-count">{counts[option.id]}</span>
            </button>
          ))}
        </div>
        <label className="st-symbol-filter-wrap">
          <span className="st-symbol-filter-label">Symbol</span>
          <input
            type="search"
            className="st-symbol-filter"
            placeholder="Filter by symbol…"
            value={symbolQuery}
            onChange={event => setSymbolQuery(event.target.value)}
          />
        </label>
        <div className="st-toolbar-spacer" />
        <BulkUnscheduleButton count={counts.scheduled} onComplete={refreshControlledExecutions} />
        <BulkStopButton count={counts.running} onComplete={refreshControlledExecutions} />
        <button
          type="button"
          className="st-btn"
          onClick={() => void refreshControlledExecutions()}
        >
          Refresh
        </button>
        <button type="button" className="st-btn st-btn--primary" onClick={openCreate}>
          New strategy
        </button>
      </div>

      {controlledExecutionsError ? (
        <div className="st-status-msg st-status-msg--error" style={{ padding: '6px 10px' }}>
          {controlledExecutionsError}
        </div>
      ) : null}
      {controlledExecutionsLoading ? (
        <div className="st-status-msg" style={{ padding: '6px 10px' }}>Loading strategies…</div>
      ) : null}

      <div className="st-body">
        <div className="st-list-wrap">
          {symbolFilteredRows.length ? (
            <div className="st-list-block" ref={listBlockRef}>
              <StrategiesTable
                rows={pagedRows}
                symbolVisuals={symbolVisuals}
                selectedId={selectedId}
                onSelect={selectStrategy}
                onLogs={setLogTarget}
              />
              <StrategiesPagination
                page={currentPage}
                pageCount={pageCount}
                onPageChange={setPage}
              />
            </div>
          ) : (
            <div className="st-list-block st-list-block--empty">
              <div className="st-empty">
                <p>
                  {symbolQuery.trim()
                    ? `No strategies match "${symbolQuery.trim()}".`
                    : filter === 'running'
                      ? 'No running strategies right now. Open Stopped or All to see saved executions.'
                      : 'No strategies yet. Create one to get started.'}
                </p>
                {!symbolQuery.trim() ? (
                  <button type="button" className="st-btn st-btn--primary" onClick={openCreate}>
                    New strategy
                  </button>
                ) : null}
              </div>
            </div>
          )}
        </div>

        <div className="st-detail-shell">
          {selectedId ? (
            <StrategyDetailPanel
              executionId={selectedId}
              symbolVisuals={symbolVisuals}
              onClose={closeDetail}
            />
          ) : (
            <StrategyDetailEmpty />
          )}
        </div>
      </div>
    </div>
  )
}

export default function Strategies() {
  return (
    <ExecutionProvider>
      <StrategiesWorkspace />
    </ExecutionProvider>
  )
}
