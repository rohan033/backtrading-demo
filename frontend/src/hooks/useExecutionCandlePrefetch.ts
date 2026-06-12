import { useEffect, useState } from 'react'

import { mergeCandleSync, sanitizeCandleSeries } from '../ExecutionWorkspace'

const CANDLE_PREFETCH_COUNT = 1000

type ExecutionRef = {
  executor_id?: string
  broker?: string
  ws_url?: string
  data_plane_status?: string
}

function isExecutionStreaming(execution: ExecutionRef | null | undefined): boolean {
  return Boolean(execution?.ws_url)
    && ['running', 'starting'].includes(String(execution?.data_plane_status || '').toLowerCase())
}

export function useExecutionCandlePrefetch(
  execution: ExecutionRef | null | undefined,
  streamCandles: ReturnType<typeof sanitizeCandleSeries>,
) {
  const [prefetchCandles, setPrefetchCandles] = useState<ReturnType<typeof sanitizeCandleSeries>>([])
  const isStreaming = isExecutionStreaming(execution)

  useEffect(() => {
    if (
      !isStreaming
      || !execution?.executor_id
      || String(execution?.broker || '').toLowerCase() !== 'etoro'
    ) {
      setPrefetchCandles([])
      return undefined
    }

    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(
          `/api/control/executions/${encodeURIComponent(execution.executor_id)}/candles?count=${CANDLE_PREFETCH_COUNT}`,
        )
        const data = await res.json()
        if (cancelled || !data.status) return
        setPrefetchCandles(sanitizeCandleSeries(data.data || []))
      } catch (error) {
        if (!cancelled) {
          console.warn('[ChartGrid] Candle prefetch failed', error)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [isStreaming, execution?.executor_id, execution?.broker])

  const candleSeries = (() => {
    if (!prefetchCandles.length) return streamCandles
    if (!streamCandles.length || streamCandles.length <= 1) return prefetchCandles
    return mergeCandleSync(prefetchCandles, streamCandles)
  })()

  return candleSeries
}
