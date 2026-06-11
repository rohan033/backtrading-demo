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
import {
  createAndStartMomentumStrategy,
  type MomentumSymbolContext,
} from '../lib/watchlistMomentumStrategy'
import type { WatchlistWindowChanges } from './useWatchlistPriceHistory'
import type { PriceSample } from '../lib/watchlistChangeColumns'
import type { Watchlist, WatchlistSymbol, WatchlistTick } from '../lib/watchlists'
import { watchlistTickKey } from '../lib/watchlists'
import { momentumSymbolKey } from '../lib/watchlistMomentumState'

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
 *  - the FIRST symbol of every momentum-enabled watchlist, and
 *  - any individual rows the user armed via the per-row momentum button.
 * orderedSymbols provides the display order (drag-reordered); falls back to watchlist.symbols.
 */
export function buildMomentumSymbolIndex(
  watchlists: Watchlist[],
  momentumWatchlistIds: Set<string>,
  orderedSymbols: Record<string, WatchlistSymbol[]>,
  momentumSymbolKeys: Set<string>,
  momentumNoTpSymbolKeys: Set<string>,
  momentumLiveSymbolKeys: Set<string>,
): Map<string, WatchlistSymbolRef> {
  const index = new Map<string, WatchlistSymbolRef>()
  for (const watchlist of watchlists) {
    const broker = (watchlist.broker || 'angel') as WatchlistBroker
    const accountEnv = watchlist.account_env || defaultAccountEnv(broker)
    const symbols = orderedSymbols[watchlist.id] ?? watchlist.symbols

    const add = (symbol: WatchlistSymbol, noTakeProfit: boolean) => {
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
        tradeEnv: momentumLiveSymbolKeys.has(key) ? 'live' : 'demo',
      })
    }

    // First symbol of a momentum-enabled watchlist (standard 5% TP)
    if (momentumWatchlistIds.has(watchlist.id) && symbols[0]) {
      add(symbols[0], false)
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

export type SymbolArchivedCallback = (params: {
  watchlistId: string
  symboltoken: string
  tradingsymbol: string
  exchange: string
  broker: string
  executionId: string
  entryPrice: number
}) => void

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
  onSymbolArchived,
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
  onSymbolArchived?: SymbolArchivedCallback
}) {
  const symbolIndex = useMemo(
    () => buildMomentumSymbolIndex(
      watchlists,
      momentumWatchlistIds,
      orderedSymbols,
      momentumSymbolKeys,
      momentumNoTpSymbolKeys,
      momentumLiveSymbolKeys,
    ),
    [
      watchlists,
      momentumWatchlistIds,
      orderedSymbols,
      momentumSymbolKeys,
      momentumNoTpSymbolKeys,
      momentumLiveSymbolKeys,
    ],
  )
  const alertCooldownRef = useRef<Record<string, number>>({})
  const deployingRef = useRef<Set<string>>(new Set())

  // Keep live data in refs so the scan interval never needs to be recreated
  // when ticks/windowChanges update (fixes interval being torn down every tick)
  const ticksRef = useRef(ticks)
  const windowChangesRef = useRef(windowChanges)
  useEffect(() => { ticksRef.current = ticks }, [ticks])
  useEffect(() => { windowChangesRef.current = windowChanges }, [windowChanges])

  const onSymbolArchivedRef = useRef(onSymbolArchived)
  useEffect(() => { onSymbolArchivedRef.current = onSymbolArchived }, [onSymbolArchived])

  const deployStrategy = useCallback(
    async (
      ctx: MomentumSymbolContext & { watchlistId?: string },
      accountEnv: 'live' | 'demo',
      signal?: MomentumSignal,
    ) => {
      const busyKey = `${ctx.token}:${accountEnv}`
      if (deployingRef.current.has(busyKey)) return null
      deployingRef.current.add(busyKey)
      try {
        const executionId = await createAndStartMomentumStrategy(ctx, accountEnv, config)
        const bracketLabel = ctx.noTakeProfit ? 'no TP (let it run) / 1% SL' : '5% TP / 1% SL'
        showPlatformToast({
          variant: 'success',
          title: accountEnv === 'live' ? 'Live strategy started' : 'Demo strategy started',
          message: `${ctx.tradingsymbol} · ${bracketLabel} · ${executionId}`,
          duration: 8000,
        })
        // Archive the symbol and advance the queue after any successful deploy
        if (ctx.watchlistId) {
          onSymbolArchivedRef.current?.({
            watchlistId: ctx.watchlistId,
            symboltoken: ctx.token,
            tradingsymbol: ctx.tradingsymbol,
            exchange: ctx.exchange,
            broker: ctx.broker,
            executionId,
            entryPrice: ctx.closePrice,
          })
        }
        return executionId
      } catch (error) {
        showPlatformToast({
          variant: 'error',
          title: accountEnv === 'live' ? 'Live deploy failed' : 'Demo deploy failed',
          message: error instanceof Error ? error.message : 'Could not start strategy',
          duration: 10000,
        })
        if (signal) {
          console.warn('[Momentum] deploy failed', ctx, error)
        }
        return null
      } finally {
        deployingRef.current.delete(busyKey)
      }
    },
    [config],
  )

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

        const tradeEnv = symbol.tradeEnv
        const bracketLabel = symbol.noTakeProfit ? 'no TP / 1% SL' : '5% TP / 1% SL'
        const ctx: MomentumSymbolContext & { watchlistId: string } = {
          broker: symbol.broker,
          tradingsymbol: symbol.tradingsymbol,
          token: symbol.token,
          exchange: symbol.exchange,
          closePrice: tick.ltp,
          watchlistId: symbol.watchlistId,
          noTakeProfit: symbol.noTakeProfit,
        }

        const message = formatMomentumToastMessage(symbol.tradingsymbol, signal, symbol.broker)
        const shouldAutoDeploy = tradeEnv === 'live' || cfg.autoDemo

        if (shouldAutoDeploy) {
          showPlatformToast({
            variant: tradeEnv === 'live' ? 'warning' : 'default',
            title: 'Fast momentum',
            message: `${message} · Auto-deploying on ${tradeEnv.toUpperCase()} (${bracketLabel})`,
            duration: tradeEnv === 'live' ? 15000 : 8000,
            highlightTitle: true,
          })
          maybeBrowserNotification(
            `Momentum · ${symbol.tradingsymbol}`,
            `${signal.headline} · deploying on ${tradeEnv}`,
          )
          void deployStrategy(ctx, tradeEnv, signal)
        } else {
          showPlatformToast({
            variant: 'warning',
            title: 'Fast momentum',
            message: `${message} · Deploy on ${tradeEnv.toUpperCase()} (${bracketLabel})?`,
            duration: 30000,
            highlightTitle: true,
            actions: {
              label: `Deploy ${tradeEnv}`,
              variant: tradeEnv === 'live' ? 'destructive' : 'default',
              onClick: () => {
                const latestTick = ticksRef.current[tickKey]
                void deployStrategy(
                  { ...ctx, closePrice: latestTick?.ltp ?? ctx.closePrice },
                  tradeEnv,
                  signal,
                )
              },
            },
          })
          maybeBrowserNotification(
            `Momentum · ${symbol.tradingsymbol}`,
            `${signal.headline} · tap to deploy on ${tradeEnv}`,
          )
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
  }, [config.enabled, config.scanEveryMs, deployStrategy, enabled, historyRef, symbolIndex])

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
