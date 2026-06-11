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
import type { Watchlist, WatchlistTick } from '../lib/watchlists'
import { watchlistTickKey } from '../lib/watchlists'

export type WatchlistSymbolRef = {
  tickKey: string
  broker: WatchlistBroker
  accountEnv: string
  tradingsymbol: string
  token: string
  exchange: string
}

function buildSymbolIndex(watchlists: Watchlist[]): Map<string, WatchlistSymbolRef> {
  const index = new Map<string, WatchlistSymbolRef>()
  for (const watchlist of watchlists) {
    const broker = (watchlist.broker || 'angel') as WatchlistBroker
    const accountEnv = watchlist.account_env || defaultAccountEnv(broker)
    for (const symbol of watchlist.symbols) {
      const tickKey = watchlistTickKey(broker, accountEnv, symbol.symboltoken)
      index.set(tickKey, {
        tickKey,
        broker,
        accountEnv,
        tradingsymbol: symbol.tradingsymbol,
        token: symbol.symboltoken,
        exchange: symbol.exchange,
      })
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

export function useWatchlistMomentumAlerts({
  watchlists,
  ticks,
  windowChanges,
  historyRef,
  enabled,
  config,
}: {
  watchlists: Watchlist[]
  ticks: Record<string, WatchlistTick>
  windowChanges: WatchlistWindowChanges
  historyRef: RefObject<Record<string, PriceSample[]>>
  enabled: boolean
  config: MomentumConfig
}) {
  const symbolIndex = useMemo(() => buildSymbolIndex(watchlists), [watchlists])
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

  const deployStrategy = useCallback(
    async (ctx: MomentumSymbolContext, accountEnv: 'live' | 'demo', signal?: MomentumSignal) => {
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
        const ctx: MomentumSymbolContext = {
          broker: symbol.broker,
          tradingsymbol: symbol.tradingsymbol,
          token: symbol.token,
          exchange: symbol.exchange,
          closePrice: tick.ltp,
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
