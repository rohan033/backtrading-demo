import { useCallback, useEffect, useRef, useState } from 'react'

import {
  appendPriceSample,
  computeWindowChanges,
  type PriceSample,
  type WatchlistChangeWindowId,
} from '../lib/watchlistChangeColumns'
import type { WatchlistTick } from '../lib/watchlists'

export type WatchlistWindowChanges = Record<string, Partial<Record<WatchlistChangeWindowId, number | null>>>

export function useWatchlistPriceHistory(ticks: Record<string, WatchlistTick>) {
  const historyRef = useRef<Record<string, PriceSample[]>>({})
  const ticksRef = useRef(ticks)
  const [windowChanges, setWindowChanges] = useState<WatchlistWindowChanges>({})

  useEffect(() => { ticksRef.current = ticks }, [ticks])

  useEffect(() => {
    const now = Date.now()
    for (const [key, tick] of Object.entries(ticks)) {
      if (!Number.isFinite(tick.ltp) || tick.ltp <= 0) continue
      historyRef.current[key] = appendPriceSample(
        historyRef.current[key] ?? [],
        tick.ltp,
        now,
      )
    }
  }, [ticks])

  const recompute = useCallback(() => {
    const now = Date.now()
    const next: WatchlistWindowChanges = {}
    for (const [key, tick] of Object.entries(ticksRef.current)) {
      const samples = historyRef.current[key]
      if (!samples?.length || !Number.isFinite(tick.ltp) || tick.ltp <= 0) continue
      next[key] = computeWindowChanges(samples, tick.ltp, now)
    }
    setWindowChanges(next)
  }, [])

  useEffect(() => {
    recompute()
    const timer = window.setInterval(recompute, 1000)
    return () => window.clearInterval(timer)
  // ticks read via ticksRef — only restart when recompute identity changes (never)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recompute])

  return { windowChanges, historyRef, forceRecompute: recompute }
}
