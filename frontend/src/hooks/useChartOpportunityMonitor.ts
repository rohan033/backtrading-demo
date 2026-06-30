import { useCallback, useEffect, useRef, useState } from 'react'

import {
  buildChartScanWindow,
  detectChartOpportunity,
  type ChartOpportunitySignal,
} from '../lib/chartOpportunityDetector'
import {
  fetchChartOpportunityBlockState,
  type ChartOpportunityLock,
  writeChartOpportunityLock,
} from '../lib/chartOpportunityLock'
import type { WatchlistSanitizedCandle } from '../lib/watchlistCandles'
import type { WatchlistBroker } from '../lib/watchlistBrokers'
import { DEFAULT_CHART_SCAN_LOOKBACK_MINUTES } from '../lib/chartOpportunityConfig'

const SCAN_INTERVAL_MS = 30_000
const COOLDOWN_MS = 10 * 60_000
const BLOCK_POLL_MS = 45_000

type Selection = {
  broker: WatchlistBroker
  accountEnv: string
  tradingsymbol: string
  symboltoken: string
}

type Options = {
  enabled: boolean
  candles: WatchlistSanitizedCandle[]
  selection: Selection | null
  lookbackMinutes?: number
  onOpportunity: (signal: ChartOpportunitySignal) => void
}

export function useChartOpportunityMonitor({
  enabled,
  candles,
  selection,
  lookbackMinutes = DEFAULT_CHART_SCAN_LOOKBACK_MINUTES,
  onOpportunity,
}: Options) {
  const [activeSignal, setActiveSignal] = useState<ChartOpportunitySignal | null>(null)
  const [scanWindow, setScanWindow] = useState<{ fromTime: number; toTime: number } | null>(null)
  const [watchSignal, setWatchSignal] = useState<ChartOpportunitySignal | null>(null)
  const [blocked, setBlocked] = useState(false)
  const [blockReason, setBlockReason] = useState<string | null>(null)

  const onOpportunityRef = useRef(onOpportunity)
  const lastFiredRef = useRef<{ signalId: string; at: number } | null>(null)
  const pendingSignalRef = useRef<ChartOpportunitySignal | null>(null)

  onOpportunityRef.current = onOpportunity

  const refreshBlockState = useCallback(async () => {
    if (!selection) {
      setBlocked(false)
      setBlockReason(null)
      return
    }

    const state = await fetchChartOpportunityBlockState(
      selection.broker,
      selection.accountEnv,
      selection.tradingsymbol,
    )
    setBlocked(state.blocked)
    setBlockReason(state.reason ?? null)
  }, [selection])

  const scan = useCallback(() => {
    if (!enabled || !selection || !candles.length) {
      if (!enabled) {
        setActiveSignal(null)
        setScanWindow(null)
        setWatchSignal(null)
      }
      return
    }

    const window = buildChartScanWindow(candles, lookbackMinutes)
    setScanWindow(window)

    if (blocked) {
      const preview = detectChartOpportunity(candles, { lookbackMinutes, minScore: 45 })
      setWatchSignal(preview)
      setActiveSignal(preview)
      return
    }

    const preview = detectChartOpportunity(candles, { lookbackMinutes, minScore: 45 })
    const signal = detectChartOpportunity(candles, { lookbackMinutes })
    setWatchSignal(preview)
    setActiveSignal(signal ?? preview)

    if (!signal) return

    const lastFired = lastFiredRef.current
    const now = Date.now()
    if (lastFired && lastFired.signalId === signal.id && now - lastFired.at < COOLDOWN_MS) {
      return
    }
    if (lastFired && now - lastFired.at < COOLDOWN_MS) {
      return
    }

    pendingSignalRef.current = signal
    lastFiredRef.current = { signalId: signal.id, at: now }
    onOpportunityRef.current(signal)
  }, [blocked, candles, enabled, lookbackMinutes, selection])

  useEffect(() => {
    if (!enabled) {
      setActiveSignal(null)
      return undefined
    }

    scan()
    const timer = window.setInterval(scan, SCAN_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [enabled, scan])

  useEffect(() => {
    void refreshBlockState()
    if (!enabled) return undefined
    const timer = window.setInterval(() => { void refreshBlockState() }, BLOCK_POLL_MS)
    return () => window.clearInterval(timer)
  }, [enabled, refreshBlockState])

  const rememberExecutionLock = useCallback((lock: ChartOpportunityLock) => {
    writeChartOpportunityLock(lock)
    setBlocked(true)
    setBlockReason('pending_lock')
  }, [])

  return {
    activeSignal,
    watchSignal,
    scanWindow,
    blocked,
    blockReason,
    rememberExecutionLock,
    refreshBlockState,
    pendingSignal: pendingSignalRef.current,
  }
}
