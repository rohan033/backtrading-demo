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
  type SymbolArchivedCallback,
} from '../hooks/useWatchlistMomentumAlerts'
import { useWatchlistHistorySeeder } from '../hooks/useWatchlistHistorySeeder'
import { useWatchlistPriceHistory } from '../hooks/useWatchlistPriceHistory'
import { useWatchlistTicks } from '../hooks/useWatchlistTicks'
import type { WindowChangesLookup } from '../lib/watchlistAutoSort'
import type { PriceSample } from '../lib/watchlistChangeColumns'
import { loadMomentumConfig } from '../lib/watchlistMomentum'
import { createAndStartMomentumStrategy } from '../lib/watchlistMomentumStrategy'
import { showPlatformToast } from '../lib/platform-toast'
import { STICKY_FEED_WATCHLIST_REFRESH_MS } from '../lib/stickyFeed'
import type { MomentumLookup } from '../lib/watchlistTopPerformers'
import {
  applySymbolOrder,
  archiveSymbol,
  loadArchivedSymbolKeys,
  loadMomentumLiveSymbolKeys,
  loadMomentumNoTpSymbolKeys,
  loadMomentumSymbolKeys,
  loadMomentumWatchlistIds,
  loadSymbolOrder,
  momentumSymbolKey,
  notifyMomentumStateChanged,
  notifySymbolArchived,
  saveMomentumLiveSymbolKeys,
  WL_MOMENTUM_CHANGED_EVENT,
  WL_SYMBOL_ARCHIVED_EVENT,
} from '../lib/watchlistMomentumState'
import {
  fetchWatchlists,
  removeWatchlistSymbol,
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

  const refreshWatchlists = useCallback(async () => {
    try {
      const data = await fetchWatchlists()
      setWatchlists(data)
      setWatchlistsReady(true)
    } catch {
      // Keep last known watchlists on transient errors.
    }
  }, [])

  useEffect(() => {
    void refreshWatchlists()
    const id = window.setInterval(() => {
      void refreshWatchlists()
    }, STICKY_FEED_WATCHLIST_REFRESH_MS)
    return () => window.clearInterval(id)
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

  const handleSymbolArchived: SymbolArchivedCallback = useCallback(params => {
    archiveSymbol({ ...params, archivedAt: Date.now() })
    notifySymbolArchived()
    void removeWatchlistSymbol(params.watchlistId, params.symboltoken)
      .then(updated => {
        setWatchlists(prev => prev.map(wl => (wl.id === params.watchlistId ? updated : wl)))
      })
      .catch(() => {
        setWatchlists(prev =>
          prev.map(wl =>
            wl.id === params.watchlistId
              ? {
                  ...wl,
                  symbols: wl.symbols.filter(s => s.symboltoken !== params.symboltoken),
                }
              : wl,
          ),
        )
      })
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
    onSymbolArchived: handleSymbolArchived,
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
        handleSymbolArchived({
          watchlistId,
          symboltoken,
          tradingsymbol,
          exchange,
          broker,
          executionId,
          entryPrice: ltp,
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
    [momentumConfig, handleSymbolArchived],
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
