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
} from '../hooks/useWatchlistMomentumAlerts'
import { MomentumDeployProvider, useMomentumDeploy } from './MomentumDeployContext'
import { useWatchlistHistorySeeder } from '../hooks/useWatchlistHistorySeeder'
import { useWatchlistPriceHistory } from '../hooks/useWatchlistPriceHistory'
import { useWatchlistTicks } from '../hooks/useWatchlistTicks'
import type { WindowChangesLookup } from '../lib/watchlistAutoSort'
import type { PriceSample } from '../lib/watchlistChangeColumns'
import { loadMomentumConfig, saveMomentumConfig, WATCHLIST_MOMENTUM_STORAGE_KEY, type MomentumConfig } from '../lib/watchlistMomentum'
import { createAndStartMomentumStrategy } from '../lib/watchlistMomentumStrategy'
import { showPlatformToast } from '../lib/platform-toast'
import type { MomentumLookup } from '../lib/watchlistTopPerformers'
import type { ArmedMomentumEntry } from '../lib/momentumQueue'
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
  setAllWatchlistDeployEnv,
  setWatchlistDeployEnv,
  WL_MOMENTUM_CHANGED_EVENT,
  WL_SYMBOL_ARCHIVED_EVENT,
} from '../lib/watchlistMomentumState'
import {
  fetchWatchlists,
  type Watchlist,
  type WatchlistTick,
} from '../lib/watchlists'

const EMPTY_STRING_SET: ReadonlySet<string> = new Set<string>()

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
  momentumConfig: MomentumConfig
  setMomentumConfig: Dispatch<SetStateAction<MomentumConfig>>
  setSymbolDeployEnv: (watchlistId: string, symboltoken: string, env: 'demo' | 'live') => void
  setAllDeployEnv: (env: 'demo' | 'live') => void
  setWatchlistDeployEnv: (watchlistId: string, env: 'demo' | 'live') => void
  deploySymbolMomentum: (args: DeploySymbolMomentumArgs) => Promise<boolean>
  momentumQueue: import('../lib/momentumQueue').MomentumQueueEntry[]
  momentumArmed: ArmedMomentumEntry[]
  armMomentumSymbol: (entry: ArmedMomentumEntry) => void
  armMomentumSymbols: (entries: ArmedMomentumEntry[]) => void
  disarmMomentumSymbol: (tickKey: string) => void
  disarmMomentumSymbols: (tickKeys: string[]) => void
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

type MomentumTradeParams = {
  watchlistId: string
  symboltoken: string
  tradingsymbol: string
  exchange: string
  broker: string
  executionId: string
  entryPrice: number
  accountEnv: 'live' | 'demo'
  noTakeProfit: boolean
}

function WatchlistStreamInner({
  children,
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
  setMomentum,
  momentumConfig,
  setMomentumConfig,
  sessionQueueOnly,
}: {
  children: ReactNode
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
  setMomentum: Dispatch<SetStateAction<MomentumLookup>>
  momentumConfig: MomentumConfig
  setMomentumConfig: Dispatch<SetStateAction<MomentumConfig>>
  sessionQueueOnly: boolean
}) {
  const { queue, armedSymbols, armSymbol, armSymbols, disarmSymbol, disarmSymbols, upsertWatching, handleMomentumSignal } = useMomentumDeploy()
  const watchlistsRef = useRef(watchlists)
  const ticksRef = useRef(ticks)

  useEffect(() => { watchlistsRef.current = watchlists }, [watchlists])
  useEffect(() => { ticksRef.current = ticks }, [ticks])

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

  const handleMomentumTrade = useCallback((params: MomentumTradeParams) => {
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
    momentumWatchlistIds: sessionQueueOnly ? EMPTY_STRING_SET : momentum.watchlistIds,
    momentumSymbolKeys: sessionQueueOnly ? EMPTY_STRING_SET : momentum.symbolKeys,
    momentumNoTpSymbolKeys: sessionQueueOnly ? EMPTY_STRING_SET : momentum.noTpSymbolKeys,
    momentumLiveSymbolKeys: momentum.liveSymbolKeys,
    orderedSymbols,
    ticks,
    windowChanges,
    historyRef,
    enabled: hasSymbols && connected,
    config: momentumConfig,
    onMomentumSignal: handleMomentumSignal,
    onWatchingUpdate: upsertWatching,
    queueArmed: sessionQueueOnly ? armedSymbols : undefined,
  })
  useMomentumNotificationPermission(momentumConfig.enabled && hasSymbols)

  const momentumRef = useRef(momentum)
  useEffect(() => { momentumRef.current = momentum }, [momentum])

  const applyDeployEnv = useCallback((
    next: Set<string>,
    _saved: boolean,
    _label: string,
    symbolCount: number,
  ) => {
    setMomentum(prev => ({ ...prev, liveSymbolKeys: new Set(next) }))
    if (!symbolCount) {
      showPlatformToast({
        variant: 'warning',
        title: 'No symbols',
        message: 'Add symbols to watchlists before setting deploy environment.',
        duration: 5000,
      })
    }
  }, [setMomentum])

  const setSymbolDeployEnv = useCallback(
    (watchlistId: string, symboltoken: string, env: 'demo' | 'live') => {
      const key = momentumSymbolKey(watchlistId, symboltoken)
      const next = new Set(momentumRef.current.liveSymbolKeys)
      if (env === 'live') next.add(key)
      else next.delete(key)
      const saved = saveMomentumLiveSymbolKeys(next)
      setMomentum(prev => ({ ...prev, liveSymbolKeys: new Set(next) }))
      if (!saved) {
        console.warn('[Momentum] could not persist live/demo deploy env after storage prune')
      }
    },
    [setMomentum],
  )

  const setAllDeployEnv = useCallback(
    (env: 'demo' | 'live') => {
      const { keys, saved, symbolCount } = setAllWatchlistDeployEnv(watchlistsRef.current, env)
      applyDeployEnv(
        keys,
        saved,
        env === 'live' ? 'All Live' : 'All Demo',
        symbolCount,
      )
    },
    [applyDeployEnv],
  )

  const setWatchlistDeployEnvForId = useCallback(
    (watchlistId: string, env: 'demo' | 'live') => {
      const wl = watchlistsRef.current.find(item => item.id === watchlistId)
      if (!wl) return
      const { keys, saved, symbolCount } = setWatchlistDeployEnv(wl, env)
      applyDeployEnv(
        keys,
        saved,
        env === 'live' ? 'Watchlist Live' : 'Watchlist Demo',
        symbolCount,
      )
    },
    [applyDeployEnv],
  )

  const deploySymbolMomentum = useCallback(
    async (args: DeploySymbolMomentumArgs): Promise<boolean> => {
      const { watchlistId, symboltoken, tradingsymbol, exchange, tickKey, noTakeProfit } = args
      const watchlist = watchlistsRef.current.find(wl => wl.id === watchlistId)
      const broker = watchlist?.broker || 'angel'
      const accountEnv: 'live' | 'demo' = momentumRef.current.liveSymbolKeys.has(
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
      momentumConfig,
      setMomentumConfig,
      setSymbolDeployEnv,
      setAllDeployEnv,
      setWatchlistDeployEnv: setWatchlistDeployEnvForId,
      deploySymbolMomentum,
      momentumQueue: queue,
      momentumArmed: armedSymbols,
      armMomentumSymbol: armSymbol,
      armMomentumSymbols: armSymbols,
      disarmMomentumSymbol: disarmSymbol,
      disarmMomentumSymbols: disarmSymbols,
    }),
    [
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
      momentumConfig,
      setMomentumConfig,
      setSymbolDeployEnv,
      setAllDeployEnv,
      setWatchlistDeployEnvForId,
      deploySymbolMomentum,
      queue,
      armedSymbols,
      armSymbol,
      armSymbols,
      disarmSymbol,
      disarmSymbols,
    ],
  )

  return (
    <WatchlistStreamContext.Provider value={value}>
      {children}
    </WatchlistStreamContext.Provider>
  )
}

export function WatchlistStreamProvider({
  children,
  sessionQueueOnly = false,
}: {
  children: ReactNode
  /** Minimal shell: momentum arms live in session queue only (no persisted watchlist toggle). */
  sessionQueueOnly?: boolean
}) {
  const [watchlists, setWatchlists] = useState<Watchlist[]>([])
  const [watchlistsReady, setWatchlistsReady] = useState(false)
  const [momentum, setMomentum] = useState<MomentumLookup>(() => loadMomentumLookup())
  const [momentumConfig, setMomentumConfig] = useState<MomentumConfig>(() => loadMomentumConfig())

  useEffect(() => {
    saveMomentumConfig(momentumConfig)
  }, [momentumConfig])

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === WATCHLIST_MOMENTUM_STORAGE_KEY) {
        setMomentumConfig(loadMomentumConfig())
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

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
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(WL_MOMENTUM_CHANGED_EVENT, onMomentumChanged)
      window.removeEventListener(WL_SYMBOL_ARCHIVED_EVENT, onSymbolArchived)
    }
  }, [refreshMomentum])

  const { ticks, connected } = useWatchlistTicks(watchlists, hasSymbols)
  const { windowChanges, historyRef, forceRecompute } = useWatchlistPriceHistory(ticks)
  useWatchlistHistorySeeder(watchlists, historyRef, forceRecompute)

  const handleMomentumTradeForProvider = useCallback((params: MomentumTradeParams) => {
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

  return (
    <MomentumDeployProvider config={momentumConfig} onMomentumTrade={handleMomentumTradeForProvider}>
      <WatchlistStreamInner
        watchlists={watchlists}
        setWatchlists={setWatchlists}
        watchlistsReady={watchlistsReady}
        refreshWatchlists={refreshWatchlists}
        ticks={ticks}
        connected={connected}
        hasSymbols={hasSymbols}
        windowChanges={windowChanges}
        historyRef={historyRef}
        momentum={momentum}
        setMomentum={setMomentum}
        momentumConfig={momentumConfig}
        setMomentumConfig={setMomentumConfig}
        sessionQueueOnly={sessionQueueOnly}
      >
        {children}
      </WatchlistStreamInner>
    </MomentumDeployProvider>
  )
}

export function useWatchlistStream() {
  const context = useContext(WatchlistStreamContext)
  if (!context) {
    throw new Error('useWatchlistStream must be used within WatchlistStreamProvider')
  }
  return context
}
