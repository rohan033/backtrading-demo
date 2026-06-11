import { useCallback, useEffect, useRef, useState } from 'react'

import { useWatchlistStream } from '../context/WatchlistStreamContext'
import type { WindowChangesLookup } from '../lib/watchlistAutoSort'
import {
  loadStickyFeedConfig,
  saveStickyFeedConfig,
  type StickyFeedConfig,
} from '../lib/stickyFeed'
import { getTopWatchlistPerformers, type RankedWatchlistSymbol } from '../lib/watchlistTopPerformers'
import { loadArchivedSymbolKeys, WL_SYMBOL_ARCHIVED_EVENT } from '../lib/watchlistMomentumState'

export function useStickyWatchlistFeed() {
  const {
    watchlists,
    hasSymbols,
    connected,
    windowChanges,
    momentum,
    setSymbolDeployEnv,
    deploySymbolMomentum,
  } = useWatchlistStream()

  const [config, setConfig] = useState<StickyFeedConfig>(() => loadStickyFeedConfig())
  const [archivedKeys, setArchivedKeys] = useState<Set<string>>(() => loadArchivedSymbolKeys())
  const [topPerformers, setTopPerformers] = useState<RankedWatchlistSymbol[]>([])

  const watchlistsRef = useRef(watchlists)
  const momentumRef = useRef(momentum)
  const configRef = useRef(config)
  const archivedKeysRef = useRef(archivedKeys)

  useEffect(() => {
    watchlistsRef.current = watchlists
  }, [watchlists])

  useEffect(() => {
    momentumRef.current = momentum
  }, [momentum])

  useEffect(() => {
    configRef.current = config
  }, [config])

  useEffect(() => {
    archivedKeysRef.current = archivedKeys
  }, [archivedKeys])

  useEffect(() => {
    const refreshArchived = () => setArchivedKeys(loadArchivedSymbolKeys())
    refreshArchived()
    window.addEventListener(WL_SYMBOL_ARCHIVED_EVENT, refreshArchived)
    return () => window.removeEventListener(WL_SYMBOL_ARCHIVED_EVENT, refreshArchived)
  }, [])

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
        archivedKeysRef.current,
      ),
    )
  }, [])

  useEffect(() => {
    resortTopPerformers()
    const id = window.setInterval(resortTopPerformers, config.sortIntervalMs)
    return () => window.clearInterval(id)
  }, [config.sortIntervalMs, resortTopPerformers])

  useEffect(() => {
    resortTopPerformers()
  }, [config.column, config.sortIntervalMs, archivedKeys, momentum, watchlists, resortTopPerformers])

  const updateConfig = useCallback((patch: Partial<StickyFeedConfig>) => {
    setConfig(prev => {
      const next = { ...prev, ...patch }
      saveStickyFeedConfig(next)
      return next
    })
  }, [])

  return {
    topPerformers,
    windowChanges,
    config,
    updateConfig,
    connected,
    hasSymbols,
    setSymbolDeployEnv,
    deploySymbolMomentum,
  }
}
