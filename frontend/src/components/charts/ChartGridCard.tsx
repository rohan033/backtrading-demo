import { useState } from 'react'
import { Link } from 'react-router-dom'

import {
  LiveExecutionChart,
  resolveExecutionPriceStreamStatus,
  stopControlledExecution,
} from '../../ExecutionWorkspace'
import { formatDbTimestamp } from '../../lib/datetime'
import type { ExecutionPnlSnapshot } from '../../hooks/useExecutionPositionsPnl'
import { formatPnl } from '../../lib/positionPnl'
import { useExecutionCandlePrefetch } from '../../hooks/useExecutionCandlePrefetch'
import CompactPositionsPanel from './CompactPositionsPanel'

const CHART_HEIGHT = 200

type StreamBundle = {
  tickHistory: unknown[]
  candleHistory: unknown[]
  tick?: { ltp?: number }
  streamKey: string
  realtimeEvents: unknown[]
  stream: {
    connected: boolean
    connectExhausted?: boolean
    connectedAt?: number
    lastTickAt?: Record<string, number>
    realtimeEvents: Array<{ executor_id?: string; details?: { executor_id?: string } }>
  }
}

type Props = {
  execution: {
    executor_id: string
    label?: string
    symbol?: string
    broker?: string
    data_plane_id?: string
    data_plane_port?: number | string
    created_at?: string | null
  }
  chartSeries: unknown[]
  streamCandles: unknown[]
  streamBundle: StreamBundle
  priceStreamStatus: ReturnType<typeof resolveExecutionPriceStreamStatus>
  pnlSnapshot?: ExecutionPnlSnapshot
  selected?: boolean
  onSelect?: (executorId: string) => void
  onExecutionStopped?: (executorId: string) => void | Promise<void>
}

function streamToneClass(tone: string): string {
  if (tone === 'ok') return 'text-green'
  if (tone === 'warn') return 'text-yellow-400'
  if (tone === 'error') return 'text-red'
  return 'text-text-secondary'
}

export default function ChartGridCard({
  execution,
  chartSeries,
  streamCandles,
  streamBundle,
  priceStreamStatus,
  pnlSnapshot,
  selected = false,
  onSelect,
  onExecutionStopped,
}: Props) {
  const liveLtp = streamBundle.tick?.ltp ?? null
  const totalPnl = pnlSnapshot?.totalPnl
  const candleSeries = useExecutionCandlePrefetch(execution, streamCandles as never[])
  const [confirmStop, setConfirmStop] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<string | null>(null)

  const executeStop = async () => {
    if (stopping) return
    setStopping(true)
    setStopError(null)
    setConfirmStop(false)
    try {
      await stopControlledExecution(execution.executor_id)
      await onExecutionStopped?.(execution.executor_id)
    } catch (err) {
      setStopError(err instanceof Error ? err.message : 'Stop failed')
    } finally {
      setStopping(false)
    }
  }

  return (
    <div
      className={`flex min-h-0 flex-col overflow-hidden rounded border transition-colors ${
        selected ? 'border-accent bg-accent/5' : 'border-border bg-card'
      }`}
    >
      <div className="flex items-start gap-2 border-b border-border/60">
        <button
          type="button"
          className="min-w-0 flex-1 px-2.5 py-2 text-left"
          onClick={() => onSelect?.(execution.executor_id)}
        >
          <div className="truncate text-[11px] font-bold leading-tight">
            {execution.symbol || execution.label || execution.executor_id}
          </div>
          <div className="mt-0.5 truncate text-[9px] text-text-secondary">
            {execution.label || execution.executor_id}
            {execution.data_plane_port ? ` · :${execution.data_plane_port}` : ''}
            {execution.created_at ? ` · ${formatDbTimestamp(execution.created_at)}` : ''}
          </div>
          <p className={`mt-0.5 text-[9px] font-semibold ${streamToneClass(priceStreamStatus.tone)}`}>
            {priceStreamStatus.label}
          </p>
        </button>
        <div className="flex shrink-0 flex-col items-end gap-1 px-2.5 py-2">
          {totalPnl != null ? (
            <span className={`font-mono text-[11px] font-bold ${totalPnl >= 0 ? 'text-green' : 'text-red'}`}>
              {formatPnl(totalPnl)}
            </span>
          ) : null}
          {selected ? (
            <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[9px] font-bold text-accent">Selected</span>
          ) : null}
          {confirmStop ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={stopping}
                onClick={executeStop}
                className="rounded border border-red/50 bg-red/15 px-1.5 py-0.5 text-[9px] font-semibold text-red disabled:opacity-50"
              >
                {stopping ? '…' : 'Yes'}
              </button>
              <button
                type="button"
                disabled={stopping}
                onClick={() => setConfirmStop(false)}
                className="rounded border border-border px-1.5 py-0.5 text-[9px] text-text-secondary disabled:opacity-50"
              >
                No
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={stopping}
              onClick={() => {
                setStopError(null)
                setConfirmStop(true)
              }}
              className="text-[9px] font-semibold text-red hover:underline disabled:opacity-50"
            >
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          )}
          <Link
            to={`/trade/strategies/${encodeURIComponent(execution.executor_id)}`}
            className="text-[9px] text-accent hover:underline"
          >
            Detail
          </Link>
        </div>
      </div>
      {stopError ? (
        <p className="border-b border-border/60 px-2.5 py-1 text-center text-[9px] text-red">{stopError}</p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 p-1.5">
          <LiveExecutionChart
            execution={execution}
            mode="candles"
            data={chartSeries}
            candleData={candleSeries}
            realtimeEvents={streamBundle.realtimeEvents}
            height={CHART_HEIGHT}
            compact
          />
        </div>
        <div className="w-[34%] min-w-[88px] max-w-[140px] shrink-0">
          <CompactPositionsPanel
            executorId={execution.executor_id}
            livePrice={liveLtp}
            onExecutionStopped={onExecutionStopped}
          />
        </div>
      </div>
    </div>
  )
}
