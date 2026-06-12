import { useEffect, useMemo, useState } from 'react'
import { LayoutGrid } from 'lucide-react'

import {
  EmptyState,
  buildCandleSeries,
  buildChartSeries,
  getPlaneStream,
  resolveExecutionPriceStreamStatus,
  resolveExecutionStream,
} from '../../ExecutionWorkspace'
import { useWatchlistStream } from '../../context/WatchlistStreamContext'
import { useExecutionPositionsPnl } from '../../hooks/useExecutionPositionsPnl'
import {
  applyWatchlistFeedToStreamStatus,
  findWatchlistFeedMatch,
  samplesToChartPoints,
} from '../../lib/watchlistFeedReuse'
import { useLiveExecutionsStreamBootstrap } from '../../hooks/useLiveExecutionsStreamBootstrap'
import {
  CHART_ENV_FILTER_OPTIONS,
  CHART_FILTER_OPTIONS,
  CHART_SORT_OPTIONS,
  type ChartColumnCount,
  type ChartEnvFilter,
  type ChartFilterKey,
  type ChartSortKey,
  filterExecutions,
  filterExecutionsByEnv,
  gridColumnClass,
  sortExecutions,
} from '../../lib/chartsGrid'
import ChartGridCard from './ChartGridCard'

const PRICE_STREAM_STATUS_POLL_MS = 5000

function useNow(intervalMs: number | null) {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!intervalMs) return undefined
    const id = window.setInterval(() => setNowMs(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return nowMs
}

type Props = {
  executions: Array<{
    executor_id: string
    ws_url?: string
    data_plane_status?: string
    data_plane_id?: string
    symbol?: string
    label?: string
    created_at?: string | null
    data_plane_port?: number | string
    account_env?: string | null
    token?: string | number | null
    broker?: string | null
  }>
  planeStreams: Record<string, unknown>
  selectedExecutionId?: string | null
  onSelectExecution?: (executorId: string) => void
  refreshControlledExecutions?: () => Promise<void>
  refreshExecutions?: () => Promise<void>
  onExecutionStopped?: (executorId: string) => void | Promise<void>
}

export default function ChartsGrid({
  executions,
  planeStreams,
  selectedExecutionId,
  onSelectExecution,
  refreshControlledExecutions,
  refreshExecutions,
  onExecutionStopped,
}: Props) {
  const { watchlists, ticks, connected, historyRef } = useWatchlistStream()
  const [sortKey, setSortKey] = useState<ChartSortKey>('profit-desc')
  const [filterKey, setFilterKey] = useState<ChartFilterKey>('all')
  const [envFilter, setEnvFilter] = useState<ChartEnvFilter>('all')
  const [columnCount, setColumnCount] = useState<ChartColumnCount>(3)

  const liveExecutions = useMemo(
    () => executions.filter(execution =>
      execution?.ws_url
      && ['running', 'starting'].includes(String(execution.data_plane_status || '').toLowerCase()),
    ),
    [executions],
  )

  useLiveExecutionsStreamBootstrap(liveExecutions, {
    refreshControlledExecutions: refreshControlledExecutions ?? (async () => {}),
    refreshExecutions: refreshExecutions ?? (async () => {}),
  })

  const nowMs = useNow(liveExecutions.length ? PRICE_STREAM_STATUS_POLL_MS : null)

  const livePriceByExecutor = useMemo(() => {
    const prices: Record<string, number | null> = {}
    for (const execution of liveExecutions) {
      const stream = getPlaneStream(planeStreams, execution.data_plane_id)
      const resolved = resolveExecutionStream(stream, execution)
      const watchlistFeed = connected
        ? findWatchlistFeedMatch(watchlists, ticks, historyRef, {
            broker: execution.broker,
            account_env: execution.account_env,
            token: execution.token,
            symbol: execution.symbol,
          })
        : null
      prices[execution.executor_id] = resolved.tick?.ltp ?? watchlistFeed?.tick?.ltp ?? null
    }
    return prices
  }, [liveExecutions, planeStreams, watchlists, ticks, connected, historyRef])

  const pnlByExecutor = useExecutionPositionsPnl(liveExecutions, livePriceByExecutor)

  const streamStatusByExecutor = useMemo(() => {
    const statuses: Record<string, ReturnType<typeof resolveExecutionPriceStreamStatus>> = {}
    for (const execution of liveExecutions) {
      const stream = getPlaneStream(planeStreams, execution.data_plane_id)
      const resolved = resolveExecutionStream(stream, execution)
      statuses[execution.executor_id] = resolveExecutionPriceStreamStatus({
        isStreaming: true,
        stream,
        streamKey: resolved.streamKey,
        nowMs,
      })
    }
    return statuses
  }, [liveExecutions, planeStreams, nowMs])

  const visibleExecutions = useMemo(() => {
    const byEnv = filterExecutionsByEnv(liveExecutions, envFilter)
    const filtered = filterExecutions(byEnv, filterKey, pnlByExecutor, streamStatusByExecutor)
    return sortExecutions(filtered, sortKey, pnlByExecutor)
  }, [liveExecutions, envFilter, filterKey, sortKey, pnlByExecutor, streamStatusByExecutor])

  if (!liveExecutions.length) {
    return (
      <EmptyState
        title="No live chart streams"
        body="Start one or more executions from the Strategy or Launch tab to stream chart data."
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-background/95 px-3 py-2 backdrop-blur-sm">
        <div className="inline-flex items-center overflow-hidden rounded-md border border-border bg-card">
          <span className="inline-flex h-[30px] items-center border-r border-border px-2.5 text-[11px] font-medium text-text-secondary">
            Env
          </span>
          {CHART_ENV_FILTER_OPTIONS.map(option => {
            const active = envFilter === option.id
            const activeClass =
              option.id === 'live'
                ? 'bg-red/15 text-red'
                : option.id === 'demo'
                  ? 'bg-accent/15 text-accent'
                  : 'bg-card-hi text-text-primary'
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setEnvFilter(option.id)}
                className={`h-[30px] px-2.5 text-[11px] font-semibold transition-colors ${
                  active ? activeClass : 'text-text-secondary hover:text-text-primary'
                }`}
              >
                {option.label}
              </button>
            )
          })}
        </div>

        <div className="inline-flex items-center overflow-hidden rounded-md border border-border bg-card">
          <span className="inline-flex h-[30px] items-center gap-1.5 border-r border-border px-2.5 text-[11px] font-medium text-text-secondary">
            <LayoutGrid className="h-3.5 w-3.5" />
            Sort
          </span>
          <select
            value={sortKey}
            onChange={event => setSortKey(event.target.value as ChartSortKey)}
            className="h-[30px] cursor-pointer border-0 bg-transparent px-2 pr-6 text-[11px] font-semibold text-text-primary outline-none"
          >
            {CHART_SORT_OPTIONS.map(option => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </div>

        <div className="inline-flex items-center overflow-hidden rounded-md border border-border bg-card">
          <span className="inline-flex h-[30px] items-center border-r border-border px-2.5 text-[11px] font-medium text-text-secondary">
            Filter
          </span>
          <select
            value={filterKey}
            onChange={event => setFilterKey(event.target.value as ChartFilterKey)}
            className="h-[30px] cursor-pointer border-0 bg-transparent px-2 pr-6 text-[11px] font-semibold text-text-primary outline-none"
          >
            {CHART_FILTER_OPTIONS.map(option => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </div>

        <div className="inline-flex items-center overflow-hidden rounded-md border border-border bg-card">
          <span className="inline-flex h-[30px] items-center border-r border-border px-2.5 text-[11px] font-medium text-text-secondary">
            Columns
          </span>
          <button
            type="button"
            onClick={() => setColumnCount(3)}
            className={`h-[30px] px-2.5 text-[11px] font-semibold ${columnCount === 3 ? 'bg-accent/15 text-accent' : 'text-text-secondary'}`}
          >
            3
          </button>
          <button
            type="button"
            onClick={() => setColumnCount(4)}
            className={`h-[30px] px-2.5 text-[11px] font-semibold ${columnCount === 4 ? 'bg-accent/15 text-accent' : 'text-text-secondary'}`}
          >
            4
          </button>
        </div>

        <span className="ml-auto text-[11px] text-text-secondary">
          {visibleExecutions.length} of {liveExecutions.length} charts
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {visibleExecutions.length ? (
          <div className={gridColumnClass(columnCount)}>
            {visibleExecutions.map(execution => {
              const stream = getPlaneStream(planeStreams, execution.data_plane_id)
              const resolvedStream = resolveExecutionStream(stream, execution)
              const { tickHistory, candleHistory, tick: streamTick, streamKey } = resolvedStream
              const watchlistFeed = connected
                ? findWatchlistFeedMatch(watchlists, ticks, historyRef, {
                    broker: execution.broker,
                    account_env: execution.account_env,
                    token: execution.token,
                    symbol: execution.symbol,
                  })
                : null
              const liveLtp = streamTick?.ltp ?? watchlistFeed?.tick?.ltp ?? null
              const historyForChart = tickHistory.length
                ? tickHistory
                : samplesToChartPoints(watchlistFeed?.samples ?? [])
              const chartSeries = buildChartSeries(historyForChart, execution, liveLtp)
              const candleSeries = buildCandleSeries(candleHistory, execution, liveLtp)
              const priceStreamStatus = applyWatchlistFeedToStreamStatus(
                streamStatusByExecutor[execution.executor_id],
                watchlistFeed,
              )
              const realtimeEvents = stream.realtimeEvents.filter(event =>
                event.executor_id === execution.executor_id
                || event.details?.executor_id === execution.executor_id,
              )

              return (
                <ChartGridCard
                  key={`${execution.data_plane_id}:${execution.executor_id}`}
                  execution={execution}
                  chartSeries={chartSeries}
                  streamCandles={candleSeries}
                  streamBundle={{
                    tickHistory,
                    candleHistory,
                    tick: streamTick,
                    streamKey,
                    realtimeEvents,
                    stream,
                  }}
                  priceStreamStatus={priceStreamStatus}
                  pnlSnapshot={pnlByExecutor[execution.executor_id]}
                  selected={execution.executor_id === selectedExecutionId}
                  onSelect={onSelectExecution}
                  onExecutionStopped={onExecutionStopped}
                />
              )
            })}
          </div>
        ) : (
          <EmptyState
            title="No charts match this filter"
            body="Try a different filter or start more executions."
          />
        )}
      </div>
    </div>
  )
}
