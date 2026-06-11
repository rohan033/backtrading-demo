import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useWatchlistHistorySeeder } from './useWatchlistHistorySeeder'
import { useWatchlistPriceHistory } from './useWatchlistPriceHistory'
import { useWatchlistTicks } from './useWatchlistTicks'
import type { WindowChangesLookup } from '../lib/watchlistAutoSort'
import {
  loadStickyFeedConfig,
  saveStickyFeedConfig,
  STICKY_FEED_WATCHLIST_REFRESH_MS,
  type StickyFeedConfig,
} from '../lib/stickyFeed'
import {
  getTopWatchlistPerformers,
  type MomentumLookup,
  type RankedWatchlistSymbol,
} from '../lib/watchlistTopPerformers'
import {
  loadMomentumLiveSymbolKeys,
  loadMomentumNoTpSymbolKeys,
  loadMomentumSymbolKeys,
  loadMomentumWatchlistIds,
} from '../lib/watchlistMomentumState'
import { fetchWatchlists, type Watchlist } from '../lib/watchlists'

function loadMomentumLookup(): MomentumLookup {
  return {
    watchlistIds: loadMomentumWatchlistIds(),
    symbolKeys: loadMomentumSymbolKeys(),
    noTpSymbolKeys: loadMomentumNoTpSymbolKeys(),
    liveSymbolKeys: loadMomentumLiveSymbolKeys(),
  }
}

export function useStickyWatchlistFeed() {
  const [watchlists, setWatchlists] = useState<Watchlist[]>([])
  const [config, setConfig] = useState<StickyFeedConfig>(() => loadStickyFeedConfig())
  const [momentum, setMomentum] = useState<MomentumLookup>(() => loadMomentumLookup())
  const [topPerformers, setTopPerformers] = useState<RankedWatchlistSymbol[]>([])

  const watchlistsRef = useRef(watchlists)
  const momentumRef = useRef(momentum)
  const configRef = useRef(config)

  useEffect(() => {
    watchlistsRef.current = watchlists
  }, [watchlists])

  useEffect(() => {
    momentumRef.current = momentum
  }, [momentum])

  useEffect(() => {
    configRef.current = config
  }, [config])

  const hasSymbols = useMemo(
    () => watchlists.some(watchlist => watchlist.symbols.length > 0),
    [watchlists],
  )

  const refreshWatchlists = useCallback(async () => {
    try {
      const data = await fetchWatchlists()
      setWatchlists(data)
    } catch {
      // Keep last known watchlists on transient errors.
    }
  }, [])

  useEffect(() => {
    refreshWatchlists()
    const id = window.setInterval(refreshWatchlists, STICKY_FEED_WATCHLIST_REFRESH_MS)
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
    window.addEventListener('storage', onStorage)
    const id = window.setInterval(refreshMomentum, 2_000)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.clearInterval(id)
    }
  }, [refreshMomentum])

  const { ticks, connected } = useWatchlistTicks(watchlists, hasSymbols)
  const { windowChanges, historyRef, forceRecompute } = useWatchlistPriceHistory(ticks)
  useWatchlistHistorySeeder(watchlists, historyRef, forceRecompute)

  const windowChangesRef = useRef<WindowChangesLookup>(windowChanges)
  useEffect(() => {
    windowChangesRef.current = windowChanges
  }, [windowChanges])

  const resortTopPerformers = useCallback(() => {
    setTopPerformers(
      getTopWatchlistPerformers(
        watchlistsRef.current,
        windowChangesRef.current,
        configRef.current.column,
        momentumRef.current,
        5,
      ),
    )
  }, [])

  useEffect(() => {
    resortTopPerformers()
    const id = window.setInterval(resortTopPerformers, config.sortIntervalMs)
    return () => window.clearInterval(id)
  }, [config.sortIntervalMs, resortTopPerformers])

  // Re-rank immediately when rank window or sort interval changes.
  useEffect(() => {
    resortTopPerformers()
  }, [config.column, config.sortIntervalMs, resortTopPerformers])

  const updateConfig = useCallback((patch: Partial<StickyFeedConfig>) => {
    setConfig(prev => {
      const next = { ...prev, ...patch }
      saveStickyFeedConfig(next)
      return next
    })
  }, [])

  return {
    watchlists,
    topPerformers,
    windowChanges,
    config,
    updateConfig,
    connected,
    hasSymbols,
    refreshWatchlists,
  }
}
