import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react'

import { showPlatformToast } from '../lib/platform-toast'
import {
  defaultAccountEnv,
  type WatchlistBroker,
} from '../lib/watchlistBrokers'
import {
  detectRapidPositiveMomentum,
  explainMomentumFilters,
  formatMomentumToastMessage,
  isCooldownActive,
  momentumCooldownKey,
  type MomentumConfig,
  type MomentumSignal,
} from '../lib/watchlistMomentum'
import type { Watchlist, WatchlistSymbol, WatchlistTick } from '../lib/watchlists'
import { watchlistTickKey } from '../lib/watchlists'
import { momentumSymbolKey } from '../lib/watchlistMomentumState'
import type { ArmedMomentumEntry } from '../lib/momentumQueue'
import type { WatchlistWindowChanges } from './useWatchlistPriceHistory'
import type { PriceSample } from '../lib/watchlistChangeColumns'

export type WatchlistSymbolRef = {
  tickKey: string
  watchlistId: string
  broker: WatchlistBroker
  accountEnv: string
  tradingsymbol: string
  token: string
  exchange: string
  /** Arm without a take-profit (high-growth: let it run). */
  noTakeProfit: boolean
  /** Per-row deploy target when momentum triggers. */
  tradeEnv: 'live' | 'demo'
}

/**
 * Builds the index of symbols to scan for momentum:
 *  - every symbol in a momentum-enabled watchlist, and
 *  - any individually armed rows (session queue or localStorage).
 * orderedSymbols provides the display order (drag-reordered); falls back to watchlist.symbols.
 */
export function buildMomentumSymbolIndex(
  watchlists: Watchlist[],
  momentumWatchlistIds: Set<string>,
  orderedSymbols: Record<string, WatchlistSymbol[]>,
  momentumSymbolKeys: Set<string>,
  momentumNoTpSymbolKeys: Set<string>,
  momentumLiveSymbolKeys: Set<string>,
  queueArmed?: ArmedMomentumEntry[] | null,
): Map<string, WatchlistSymbolRef> {
  const index = new Map<string, WatchlistSymbolRef>()
  const armedByTickKey = new Map(
    (queueArmed ?? []).map(entry => [entry.tickKey, entry]),
  )

  for (const watchlist of watchlists) {
    const broker = (watchlist.broker || 'angel') as WatchlistBroker
    const accountEnv = watchlist.account_env || defaultAccountEnv(broker)
    const symbols = orderedSymbols[watchlist.id] ?? watchlist.symbols

    const add = (symbol: WatchlistSymbol, noTakeProfit: boolean, tradeEnv?: 'live' | 'demo') => {
      const tickKey = watchlistTickKey(broker, accountEnv, symbol.symboltoken)
      if (index.has(tickKey)) return
      const key = momentumSymbolKey(watchlist.id, symbol.symboltoken)
      index.set(tickKey, {
        tickKey,
        watchlistId: watchlist.id,
        broker,
        accountEnv,
        tradingsymbol: symbol.tradingsymbol,
        token: symbol.symboltoken,
        exchange: symbol.exchange,
        noTakeProfit,
        tradeEnv: tradeEnv ?? (momentumLiveSymbolKeys.has(key) ? 'live' : 'demo'),
      })
    }

    // Session queue only — skip persisted watchlist-wide momentum.
    if (queueArmed != null) {
      for (const symbol of symbols) {
        const tickKey = watchlistTickKey(broker, accountEnv, symbol.symboltoken)
        const armed = armedByTickKey.get(tickKey)
        if (armed) {
          add(symbol, armed.noTakeProfit, armed.tradeEnv)
        }
      }
      continue
    }

    // Legacy: whole watchlist momentum (persistent toggle).
    if (momentumWatchlistIds.has(watchlist.id)) {
      for (const symbol of symbols) {
        add(symbol, false)
      }
    }

    // Individually armed rows — no-TP arming takes precedence over standard.
    for (const symbol of symbols) {
      const key = momentumSymbolKey(watchlist.id, symbol.symboltoken)
      if (momentumNoTpSymbolKeys.has(key)) {
        add(symbol, true)
      } else if (momentumSymbolKeys.has(key)) {
        add(symbol, false)
      }
    }
  }
  return index
}

function maybeBrowserNotification(title: string, body: string) {
  if (typeof window === 'undefined' || document.visibilityState === 'visible') return
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  try {
    const note = new Notification(title, { body })
    note.onclick = () => window.focus()
  } catch {
    // ignore unsupported notification environments
  }
}

export type MomentumSignalCallback = (params: {
  tickKey: string
  watchlistId: string
  symboltoken: string
  tradingsymbol: string
  broker: string
  exchange: string
  token: string
  tradeEnv: 'live' | 'demo'
  noTakeProfit: boolean
  closePrice: number
  signal: MomentumSignal
  autoDemo: boolean
}) => void

export type MomentumWatchingCallback = (entries: Array<{
  id: string
  tickKey: string
  watchlistId: string
  symboltoken: string
  tradingsymbol: string
  broker: string
  tradeEnv: 'live' | 'demo'
  noTakeProfit: boolean
  currentPrice: number | null
}>) => void

export function useWatchlistMomentumAlerts({
  watchlists,
  momentumWatchlistIds,
  momentumSymbolKeys,
  momentumNoTpSymbolKeys,
  momentumLiveSymbolKeys,
  orderedSymbols,
  ticks,
  windowChanges,
  historyRef,
  enabled,
  config,
  onMomentumSignal,
  onWatchingUpdate,
  queueArmed,
}: {
  watchlists: Watchlist[]
  momentumWatchlistIds: Set<string>
  momentumSymbolKeys: Set<string>
  momentumNoTpSymbolKeys: Set<string>
  momentumLiveSymbolKeys: Set<string>
  orderedSymbols: Record<string, WatchlistSymbol[]>
  ticks: Record<string, WatchlistTick>
  windowChanges: WatchlistWindowChanges
  historyRef: RefObject<Record<string, PriceSample[]>>
  enabled: boolean
  config: MomentumConfig
  onMomentumSignal?: MomentumSignalCallback
  onWatchingUpdate?: MomentumWatchingCallback
  /** Session queue arms from minimal shell — when set, replaces localStorage symbol keys. */
  queueArmed?: ArmedMomentumEntry[] | null
}) {
  const symbolIndex = useMemo(
    () => buildMomentumSymbolIndex(
      watchlists,
      momentumWatchlistIds,
      orderedSymbols,
      momentumSymbolKeys,
      momentumNoTpSymbolKeys,
      momentumLiveSymbolKeys,
      queueArmed,
    ),
    [
      watchlists,
      momentumWatchlistIds,
      orderedSymbols,
      momentumSymbolKeys,
      momentumNoTpSymbolKeys,
      momentumLiveSymbolKeys,
      queueArmed,
    ],
  )
  const alertCooldownRef = useRef<Record<string, number>>({})
  const signalCooldownRef = useRef<Record<string, number>>({})

  // Keep live data in refs so the scan interval never needs to be recreated
  // when ticks/windowChanges update (fixes interval being torn down every tick)
  const ticksRef = useRef(ticks)
  const windowChangesRef = useRef(windowChanges)
  useEffect(() => { ticksRef.current = ticks }, [ticks])
  useEffect(() => { windowChangesRef.current = windowChanges }, [windowChanges])

  const onMomentumSignalRef = useRef(onMomentumSignal)
  useEffect(() => { onMomentumSignalRef.current = onMomentumSignal }, [onMomentumSignal])

  const onWatchingUpdateRef = useRef(onWatchingUpdate)
  useEffect(() => { onWatchingUpdateRef.current = onWatchingUpdate }, [onWatchingUpdate])

  useEffect(() => {
    onWatchingUpdateRef.current?.(
      [...symbolIndex.entries()].map(([tickKey, symbol]) => ({
        id: tickKey,
        tickKey,
        watchlistId: symbol.watchlistId,
        symboltoken: symbol.token,
        tradingsymbol: symbol.tradingsymbol,
        broker: symbol.broker,
        tradeEnv: symbol.tradeEnv,
        noTakeProfit: symbol.noTakeProfit,
        currentPrice: ticksRef.current[tickKey]?.ltp ?? null,
      })),
    )
  }, [symbolIndex])

  useEffect(() => {
    if (symbolIndex.size === 0) return
    onWatchingUpdateRef.current?.(
      [...symbolIndex.entries()].map(([tickKey, symbol]) => ({
        id: tickKey,
        tickKey,
        watchlistId: symbol.watchlistId,
        symboltoken: symbol.token,
        tradingsymbol: symbol.tradingsymbol,
        broker: symbol.broker,
        tradeEnv: symbol.tradeEnv,
        noTakeProfit: symbol.noTakeProfit,
        currentPrice: ticks[tickKey]?.ltp ?? null,
      })),
    )
  }, [symbolIndex, ticks])

  // Keep latest config in a ref too so the closure never goes stale
  const configRef = useRef(config)
  useEffect(() => { configRef.current = config }, [config])

  useEffect(() => {
    if (!enabled || !config.enabled) return

    const scan = () => {
      const now = Date.now()
      const cfg = configRef.current
      for (const [tickKey, symbol] of symbolIndex.entries()) {
        const tick = ticksRef.current[tickKey]
        const changes = windowChangesRef.current[tickKey]
        const samples = historyRef.current?.[tickKey] ?? []

        const filterReport = explainMomentumFilters(changes ?? {}, samples, {
          tickDirection: tick?.direction,
          currentLtp: tick?.ltp,
          config: cfg,
          now,
        })

        if (!tick || !changes) {
          console.info(
            `[Momentum] skip ${symbol.tradingsymbol}: missing tick or change data`,
          )
          continue
        }

        if (cfg.complexMode && samples.length < 2) {
          console.info(
            `[Momentum] skip ${symbol.tradingsymbol}: need price history (complex mode)`,
          )
          continue
        }

        if (!cfg.complexMode && changes['1m'] == null) {
          console.info(
            `[Momentum] skip ${symbol.tradingsymbol}: 1m change not ready yet`,
          )
          continue
        }

        const signal = detectRapidPositiveMomentum(changes, samples, {
          tickDirection: tick.direction,
          currentLtp: tick.ltp,
          config: cfg,
          now,
        })
        if (!signal) {
          console.info(
            `[Momentum] ${symbol.tradingsymbol} not triggered: ${filterReport.reasons.join(' | ')}`,
          )
          continue
        }

        const alertKey = momentumCooldownKey(tickKey, 'alert')
        if (isCooldownActive(alertCooldownRef.current, alertKey, cfg.cooldownMs, now)) {
          console.info(
            `[Momentum] ${symbol.tradingsymbol} cooldown active (${Math.round(cfg.cooldownMs / 60_000)}m)`,
          )
          continue
        }
        alertCooldownRef.current[alertKey] = now

        const signalKey = momentumCooldownKey(tickKey, 'signal')
        if (isCooldownActive(signalCooldownRef.current, signalKey, cfg.cooldownMs, now)) {
          console.info(
            `[Momentum] ${symbol.tradingsymbol} signal cooldown active`,
          )
          continue
        }
        signalCooldownRef.current[signalKey] = now

        const tradeEnv = symbol.tradeEnv
        const message = formatMomentumToastMessage(symbol.tradingsymbol, signal, symbol.broker)

        maybeBrowserNotification(
          `Momentum · ${symbol.tradingsymbol}`,
          `${signal.headline} · ${tradeEnv === 'live' ? 'approve to deploy' : 'deploying'}`,
        )

        onMomentumSignalRef.current?.({
          tickKey,
          watchlistId: symbol.watchlistId,
          symboltoken: symbol.token,
          tradingsymbol: symbol.tradingsymbol,
          broker: symbol.broker,
          exchange: symbol.exchange,
          token: symbol.token,
          tradeEnv,
          noTakeProfit: symbol.noTakeProfit,
          closePrice: tick.ltp,
          signal,
          autoDemo: cfg.autoDemo,
        })

        if (tradeEnv === 'demo' && !cfg.autoDemo) {
          showPlatformToast({
            variant: 'warning',
            title: 'Fast momentum',
            message,
            duration: 30_000,
            highlightTitle: true,
          })
        }
      }
    }

    const interval = Math.max(500, config.scanEveryMs ?? 2000)
    const monitored = [...symbolIndex.values()].map(
      symbol => `${symbol.tradingsymbol}(${symbol.tradeEnv})`,
    )
    console.info(
      `[Momentum] scan started — every ${interval}ms, monitoring: ${monitored.join(', ') || 'none'}`,
    )
    scan()
    const timer = window.setInterval(scan, interval)
    return () => {
      console.info('[Momentum] scan interval cleared')
      window.clearInterval(timer)
    }
  // ticks and windowChanges deliberately excluded — live data is read via refs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.enabled, config.scanEveryMs, enabled, historyRef, symbolIndex])

  return {
    monitoredSymbols: useMemo(
      () => [...symbolIndex.values()].map(symbol => ({
        symbol: symbol.tradingsymbol,
        tradeEnv: symbol.tradeEnv,
        noTakeProfit: symbol.noTakeProfit,
      })),
      [symbolIndex],
    ),
  }
}

export function useMomentumNotificationPermission(enabled: boolean) {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || !('Notification' in window)) return
    if (Notification.permission === 'default') {
      void Notification.requestPermission()
    }
  }, [enabled])
}
