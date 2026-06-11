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

export type WatchlistSymbolRef = {
  tickKey: string
  watchlistId: string
  broker: WatchlistBroker
  accountEnv: string
  tradingsymbol: string
  token: string
  exchange: string
}

/**
 * Builds an index of ONLY the first symbol from each momentum-enabled watchlist.
 * orderedSymbols provides the display order (drag-reordered); falls back to watchlist.symbols.
 */
function buildSymbolIndex(
  watchlists: Watchlist[],
  momentumWatchlistIds: Set<string>,
  orderedSymbols: Record<string, WatchlistSymbol[]>,
): Map<string, WatchlistSymbolRef> {
  const index = new Map<string, WatchlistSymbolRef>()
  for (const watchlist of watchlists) {
    if (!momentumWatchlistIds.has(watchlist.id)) continue
    const broker = (watchlist.broker || 'angel') as WatchlistBroker
    const accountEnv = watchlist.account_env || defaultAccountEnv(broker)
    const symbols = orderedSymbols[watchlist.id] ?? watchlist.symbols
    const first = symbols[0]
    if (!first) continue
    const tickKey = watchlistTickKey(broker, accountEnv, first.symboltoken)
    index.set(tickKey, {
      tickKey,
      watchlistId: watchlist.id,
      broker,
      accountEnv,
      tradingsymbol: first.tradingsymbol,
      token: first.symboltoken,
      exchange: first.exchange,
    })
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
  orderedSymbols: Record<string, WatchlistSymbol[]>
  ticks: Record<string, WatchlistTick>
  windowChanges: WatchlistWindowChanges
  historyRef: RefObject<Record<string, PriceSample[]>>
  enabled: boolean
  config: MomentumConfig
  onSymbolArchived?: SymbolArchivedCallback
}) {
  const symbolIndex = useMemo(
    () => buildSymbolIndex(watchlists, momentumWatchlistIds, orderedSymbols),
    [watchlists, momentumWatchlistIds, orderedSymbols],
  )
  const alertCooldownRef = useRef<Record<string, number>>({})
  const demoCooldownRef = useRef<Record<string, number>>({})
  const deployingRef = useRef<Set<string>>(new Set())
  const pendingLiveRef = useRef<Map<string, MomentumSymbolContext>>(new Map())

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
        showPlatformToast({
          variant: 'success',
          title: accountEnv === 'live' ? 'Live strategy started' : 'Demo strategy started',
          message: `${ctx.tradingsymbol} · 5% TP / 1% SL · ${executionId}`,
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

        // Debug: always log what we see for each symbol so you can trace rejections
        console.debug(
          `[Momentum scan] ${symbol.tradingsymbol}`,
          explainMomentumFilters(changes ?? {}, samples, {
            tickDirection: tick?.direction,
            currentLtp: tick?.ltp,
            config: cfg,
            now,
          }).reasons.join(' | '),
        )

        if (!tick || !changes || samples.length < 2) continue

        const signal = detectRapidPositiveMomentum(changes, samples, {
          tickDirection: tick.direction,
          currentLtp: tick.ltp,
          config: cfg,
          now,
        })
        if (!signal) continue

        const alertKey = momentumCooldownKey(tickKey, 'alert')
        const demoKey = momentumCooldownKey(tickKey, 'demo')
        const ctx: MomentumSymbolContext & { watchlistId: string } = {
          broker: symbol.broker,
          tradingsymbol: symbol.tradingsymbol,
          token: symbol.token,
          exchange: symbol.exchange,
          closePrice: tick.ltp,
          watchlistId: symbol.watchlistId,
        }

        if (cfg.autoDemo && !isCooldownActive(demoCooldownRef.current, demoKey, cfg.cooldownMs, now)) {
          demoCooldownRef.current[demoKey] = now
          void deployStrategy(ctx, 'demo', signal)
        }

        if (isCooldownActive(alertCooldownRef.current, alertKey, cfg.cooldownMs, now)) continue
        alertCooldownRef.current[alertKey] = now

        const message = formatMomentumToastMessage(symbol.tradingsymbol, signal, symbol.broker)
        pendingLiveRef.current.set(tickKey, ctx)

        showPlatformToast({
          variant: 'warning',
          title: 'Fast momentum',
          message: `${message} · Deploy live with 5% take-profit and 1% stop-loss?`,
          duration: 30000,
          highlightTitle: true,
          actions: {
            label: 'Deploy live',
            variant: 'default',
            onClick: () => {
              const latest = pendingLiveRef.current.get(tickKey) ?? ctx
              const liveTick = ticksRef.current[tickKey]
              void deployStrategy(
                {
                  ...latest,
                  closePrice: liveTick?.ltp ?? latest.closePrice,
                },
                'live',
                signal,
              )
            },
          },
        })

        maybeBrowserNotification(
          `Momentum · ${symbol.tradingsymbol}`,
          `${signal.headline} · tap to return and deploy live`,
        )
      }
    }

    const interval = Math.max(500, config.scanEveryMs ?? 2000)
    console.info(`[Momentum] scan interval started — every ${interval}ms, symbols: ${symbolIndex.size}`)
    const timer = window.setInterval(scan, interval)
    return () => {
      console.info('[Momentum] scan interval cleared')
      window.clearInterval(timer)
    }
  // ticks and windowChanges deliberately excluded — live data is read via refs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.enabled, config.scanEveryMs, deployStrategy, enabled, historyRef, symbolIndex])
}

export function useMomentumNotificationPermission(enabled: boolean) {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || !('Notification' in window)) return
    if (Notification.permission === 'default') {
      void Notification.requestPermission()
    }
  }, [enabled])
}
