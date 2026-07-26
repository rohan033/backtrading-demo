import { useCallback, useEffect, useMemo, useState } from 'react'

import { useTradeHalts } from '../context/TradeHaltsContext'
import { classifyHaltDirection } from '../lib/overviewHaltDirection'
import {
  buildOverviewTradeSignals,
  collectTopScreenerPicks,
  type OverviewTradeSignal,
} from '../lib/overviewSignals'
import { fetchScreeners, type Screener } from '../lib/screenerApi'
import { currentlyHaltedHalts } from '../lib/tradeHaltsUi'
import { useOverviewCandleCache } from './useOverviewCandleCache'

export function useOverviewTradeSignals(options: {
  enabled: boolean
  accountEnv: 'demo' | 'live'
}) {
  const { enabled, accountEnv } = options
  const { halts } = useTradeHalts()
  const [screeners, setScreeners] = useState<Screener[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const loadScreeners = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    setError('')
    try {
      setScreeners(await fetchScreeners(true))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load overview suggestions')
      setScreeners([])
    } finally {
      setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    void loadScreeners()
  }, [loadScreeners])

  const halted = useMemo(() => currentlyHaltedHalts(halts), [halts])

  const candleSymbols = useMemo(() => {
    const symbols = new Set<string>()
    for (const halt of halted) symbols.add(halt.symbol.toUpperCase())
    for (const pick of collectTopScreenerPicks(screeners)) {
      symbols.add(pick.symbol)
    }
    return [...symbols]
  }, [halted, screeners])

  const candlesEnabled = enabled && candleSymbols.length > 0
  const { candlesBySymbol, loading: candlesLoading } = useOverviewCandleCache(
    candleSymbols,
    accountEnv,
    candlesEnabled,
  )

  const haltedAnalysis = useMemo(() => {
    return halted.map(halt => {
      const symbol = halt.symbol.toUpperCase()
      const candles = candlesBySymbol[symbol] || []
      const threshold = halt.pause_threshold_price != null
        ? Number(halt.pause_threshold_price)
        : null
      const analysis = classifyHaltDirection(candles, {
        pauseThreshold: Number.isFinite(threshold) ? threshold : null,
      })
      return { halt, symbol, ...analysis }
    })
  }, [halted, candlesBySymbol])

  const signals: OverviewTradeSignal[] = useMemo(() => buildOverviewTradeSignals({
    screeners,
    haltedSymbols: haltedAnalysis.map(item => ({
      symbol: item.symbol,
      direction: item.direction,
      changePct: item.changePct,
    })),
    candlesBySymbol,
  }), [screeners, haltedAnalysis, candlesBySymbol])

  return {
    signals,
    screenerPicks: collectTopScreenerPicks(screeners),
    candlesBySymbol,
    loading: loading || (candlesEnabled && candlesLoading),
    error,
    refresh: loadScreeners,
  }
}
