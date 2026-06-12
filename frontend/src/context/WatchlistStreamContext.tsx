import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from 'react'

import {
  useMomentumNotificationPermission,
  useWatchlistMomentumAlerts,
  type MomentumTradeCallback,
} from '../hooks/useWatchlistMomentumAlerts'
import { useWatchlistHistorySeeder } from '../hooks/useWatchlistHistorySeeder'
import { useWatchlistPriceHistory } from '../hooks/useWatchlistPriceHistory'
import { useWatchlistTicks } from '../hooks/useWatchlistTicks'
import type { WindowChangesLookup } from '../lib/watchlistAutoSort'
import type { PriceSample } from '../lib/watchlistChangeColumns'
import { loadMomentumConfig } from '../lib/watchlistMomentum'
import { createAndStartMomentumStrategy } from '../lib/watchlistMomentumStrategy'
import { showPlatformToast } from '../lib/platform-toast'
import type { MomentumLookup } from '../lib/watchlistTopPerformers'
import {
  applySymbolOrder,
  loadMomentumLiveSymbolKeys,
  loadMomentumNoTpSymbolKeys,
  loadMomentumSymbolKeys,
  loadMomentumWatchlistIds,
  loadSymbolOrder,
  momentumSymbolKey,
  notifyMomentumStateChanged,
  notifyMomentumTrade,
  recordMomentumTrade,
  saveMomentumLiveSymbolKeys,
  WL_MOMENTUM_CHANGED_EVENT,
  WL_SYMBOL_ARCHIVED_EVENT,
} from '../lib/watchlistMomentumState'
import {
  fetchWatchlists,
  type Watchlist,
  type WatchlistTick,
} from '../lib/watchlists'

function loadMomentumLookup(): MomentumLookup {
  return {
    watchlistIds: loadMomentumWatchlistIds(),
    symbolKeys: loadMomentumSymbolKeys(),
    noTpSymbolKeys: loadMomentumNoTpSymbolKeys(),
    liveSymbolKeys: loadMomentumLiveSymbolKeys(),
  }
}

type WatchlistStreamContextValue = {
  watchlists: Watchlist[]
  setWatchlists: Dispatch<SetStateAction<Watchlist[]>>
  watchlistsReady: boolean
  refreshWatchlists: () => Promise<void>
  ticks: Record<string, WatchlistTick>
  connected: boolean
  hasSymbols: boolean
  windowChanges: WindowChangesLookup
  historyRef: RefObject<Record<string, PriceSample[]>>
  momentum: MomentumLookup
  setSymbolDeployEnv: (watchlistId: string, symboltoken: string, env: 'demo' | 'live') => void
  deploySymbolMomentum: (args: DeploySymbolMomentumArgs) => Promise<boolean>
}

export type DeploySymbolMomentumArgs = {
  watchlistId: string
  symboltoken: string
  tradingsymbol: string
  exchange: string
  tickKey: string
  noTakeProfit: boolean
}

const WatchlistStreamContext = createContext<WatchlistStreamContextValue | null>(null)

export function WatchlistStreamProvider({ children }: { children: ReactNode }) {
  const [watchlists, setWatchlists] = useState<Watchlist[]>([])
  const [watchlistsReady, setWatchlistsReady] = useState(false)
  const [momentum, setMomentum] = useState<MomentumLookup>(() => loadMomentumLookup())
  const momentumConfig = useMemo(() => loadMomentumConfig(), [])

  const hasSymbols = useMemo(
    () => watchlists.some(watchlist => watchlist.symbols.length > 0),
    [watchlists],
  )

  const watchlistsFetchRef = useRef({ inFlight: false, lastAt: 0 })

  const refreshWatchlists = useCallback(async () => {
    const gate = watchlistsFetchRef.current
    const now = Date.now()
    if (gate.inFlight || now - gate.lastAt < 2_000) return
    gate.inFlight = true
    try {
      const data = await fetchWatchlists()
      setWatchlists(data)
      setWatchlistsReady(true)
      gate.lastAt = Date.now()
    } catch {
      // Keep last known watchlists on transient errors.
    } finally {
      gate.inFlight = false
    }
  }, [])

  useEffect(() => {
    // Fetch the watchlist config once to bootstrap WebSocket subscriptions.
    // Live prices then flow over /ws/watchlist and in-app edits update state
    // directly — so there's no REST polling. We only re-fetch when the tab
    // regains focus, to catch edits made elsewhere (other tab/device).
    void refreshWatchlists()
    let focusTimer: ReturnType<typeof setTimeout> | undefined
    const onFocus = () => {
      if (document.visibilityState !== 'visible') return
      if (focusTimer) clearTimeout(focusTimer)
      focusTimer = setTimeout(() => {
        void refreshWatchlists()
      }, 250)
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      if (focusTimer) clearTimeout(focusTimer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [refreshWatchlists])

  const refreshMomentum = useCallback(() => {
    setMomentum(loadMomentumLookup())
  }, [])

  useEffect(() => {
    refreshMomentum()
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key.startsWith('wl-')) refreshMomentum()
    }
    const onMomentumChanged = () => refreshMomentum()
    const onSymbolArchived = () => refreshMomentum()
    window.addEventListener('storage', onStorage)
    window.addEventListener(WL_MOMENTUM_CHANGED_EVENT, onMomentumChanged)
    window.addEventListener(WL_SYMBOL_ARCHIVED_EVENT, onSymbolArchived)
    const id = window.setInterval(refreshMomentum, 2_000)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(WL_MOMENTUM_CHANGED_EVENT, onMomentumChanged)
      window.removeEventListener(WL_SYMBOL_ARCHIVED_EVENT, onSymbolArchived)
      window.clearInterval(id)
    }
  }, [refreshMomentum])

  const { ticks, connected } = useWatchlistTicks(watchlists, hasSymbols)
  const { windowChanges, historyRef, forceRecompute } = useWatchlistPriceHistory(ticks)
  useWatchlistHistorySeeder(watchlists, historyRef, forceRecompute)

  const ticksRef = useRef(ticks)
  const watchlistsRef = useRef(watchlists)
  useEffect(() => {
    ticksRef.current = ticks
  }, [ticks])
  useEffect(() => {
    watchlistsRef.current = watchlists
  }, [watchlists])

  const orderedSymbols = useMemo(
    () =>
      Object.fromEntries(
        watchlists.map(watchlist => [
          watchlist.id,
          applySymbolOrder(watchlist.symbols, loadSymbolOrder(watchlist.id)),
        ]),
      ),
    [watchlists],
  )

  // Records a momentum order in the trades log. Unlike the old archive flow, the
  // symbol stays in its watchlist — we just append a record of the placed order.
  const handleMomentumTrade: MomentumTradeCallback = useCallback(params => {
    recordMomentumTrade({
      id: `${params.executionId || params.symboltoken}-${Date.now()}`,
      watchlistId: params.watchlistId,
      symboltoken: params.symboltoken,
      tradingsymbol: params.tradingsymbol,
      exchange: params.exchange,
      broker: params.broker,
      executionId: params.executionId,
      accountEnv: params.accountEnv,
      noTakeProfit: params.noTakeProfit,
      entryPrice: params.entryPrice,
      createdAt: Date.now(),
    })
    notifyMomentumTrade()
  }, [])

  useWatchlistMomentumAlerts({
    watchlists,
    momentumWatchlistIds: momentum.watchlistIds,
    momentumSymbolKeys: momentum.symbolKeys,
    momentumNoTpSymbolKeys: momentum.noTpSymbolKeys,
    momentumLiveSymbolKeys: momentum.liveSymbolKeys,
    orderedSymbols,
    ticks,
    windowChanges,
    historyRef,
    enabled: hasSymbols && connected,
    config: momentumConfig,
    onMomentumTrade: handleMomentumTrade,
  })
  useMomentumNotificationPermission(momentumConfig.enabled && hasSymbols)

  // D / L only choose the deploy environment — they never place an order.
  const setSymbolDeployEnv = useCallback(
    (watchlistId: string, symboltoken: string, env: 'demo' | 'live') => {
      const key = momentumSymbolKey(watchlistId, symboltoken)
      const next = new Set(loadMomentumLiveSymbolKeys())
      if (env === 'live') next.add(key)
      else next.delete(key)
      saveMomentumLiveSymbolKeys(next)
      setMomentum(prev => ({ ...prev, liveSymbolKeys: next }))
      notifyMomentumStateChanged()
    },
    [],
  )

  // Pressing a momentum button places the bracket order immediately (after the
  // caller's confirmation), then archives the symbol out of the watchlist/feed.
  const deploySymbolMomentum = useCallback(
    async (args: DeploySymbolMomentumArgs): Promise<boolean> => {
      const { watchlistId, symboltoken, tradingsymbol, exchange, tickKey, noTakeProfit } = args
      const watchlist = watchlistsRef.current.find(wl => wl.id === watchlistId)
      const broker = watchlist?.broker || 'angel'
      const accountEnv: 'live' | 'demo' = loadMomentumLiveSymbolKeys().has(
        momentumSymbolKey(watchlistId, symboltoken),
      )
        ? 'live'
        : 'demo'
      const ltp = ticksRef.current[tickKey]?.ltp
      if (!ltp || !Number.isFinite(ltp)) {
        showPlatformToast({
          variant: 'error',
          title: 'No live price yet',
          message: `${tradingsymbol} has no live quote — try again in a moment`,
          duration: 6000,
        })
        return false
      }
      try {
        const executionId = await createAndStartMomentumStrategy(
          {
            broker,
            tradingsymbol,
            token: symboltoken,
            exchange,
            closePrice: ltp,
            watchlistId,
            noTakeProfit,
          },
          accountEnv,
          momentumConfig,
        )
        const bracketLabel = noTakeProfit ? 'no TP (let it run) / 1% SL' : '5% TP / 1% SL'
        showPlatformToast({
          variant: 'success',
          title: accountEnv === 'live' ? 'Live strategy started' : 'Demo strategy started',
          message: `${tradingsymbol} · ${bracketLabel} · ${executionId}`,
          duration: 8000,
        })
        handleMomentumTrade({
          watchlistId,
          symboltoken,
          tradingsymbol,
          exchange,
          broker,
          executionId,
          entryPrice: ltp,
          accountEnv,
          noTakeProfit,
        })
        return true
      } catch (error) {
        showPlatformToast({
          variant: 'error',
          title: accountEnv === 'live' ? 'Live deploy failed' : 'Demo deploy failed',
          message: error instanceof Error ? error.message : 'Could not start strategy',
          duration: 10000,
        })
        return false
      }
    },
    [momentumConfig, handleMomentumTrade],
  )

  const value = useMemo(
    () => ({
      watchlists,
      setWatchlists,
      watchlistsReady,
      refreshWatchlists,
      ticks,
      connected,
      hasSymbols,
      windowChanges,
      historyRef,
      momentum,
      setSymbolDeployEnv,
      deploySymbolMomentum,
    }),
    [
      watchlists,
      watchlistsReady,
      refreshWatchlists,
      ticks,
      connected,
      hasSymbols,
      windowChanges,
      historyRef,
      momentum,
      setSymbolDeployEnv,
      deploySymbolMomentum,
    ],
  )

  return (
    <WatchlistStreamContext.Provider value={value}>
      {children}
    </WatchlistStreamContext.Provider>
  )
}

export function useWatchlistStream() {
  const context = useContext(WatchlistStreamContext)
  if (!context) {
    throw new Error('useWatchlistStream must be used within WatchlistStreamProvider')
  }
  return context
}
