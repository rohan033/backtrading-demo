import { useEffect, useMemo, useRef } from 'react'

import { useWatchlistStream } from '@/context/WatchlistStreamContext'
import {
  pickWatchlistSymbolMatch,
  searchWatchlistSymbol,
  type WatchlistSymbolHit,
} from '@/lib/watchlistBrokers'
import { isSymbolOnWatchlistFeed } from '@/lib/watchlistFeedReuse'
import { addWatchlistSymbol, createWatchlist, type Watchlist } from '@/lib/watchlists'

const POSITIONS_FEED_WATCHLIST = 'Positions feed'
const RETRY_MS = 15000

export type PositionFeedTarget = {
  symboltoken: string
  tradingsymbol: string
  symbol?: string | null
}

function hitToSymbolPayload(hit: WatchlistSymbolHit) {
  return {
    symboltoken: hit.symboltoken,
    tradingsymbol: hit.tradingsymbol,
    exchange: hit.exchange || 'ETORO',
    symbol: hit.name || hit.symbol || hit.tradingsymbol,
    internal_asset_class_name: hit.internalAssetClassName ?? null,
    instrument_display_name: hit.instrumentDisplayName || hit.name || hit.tradingsymbol,
    logo35x35: hit.logo35x35 ?? null,
    logo50x50: hit.logo50x50 ?? null,
    logo150x150: hit.logo150x150 ?? null,
    raw_metadata: hit.raw ?? null,
  }
}

function targetToSymbolPayload(target: PositionFeedTarget) {
  const tradingsymbol = target.tradingsymbol.trim() || target.symboltoken
  const label = target.symbol?.trim() || tradingsymbol
  return {
    symboltoken: target.symboltoken,
    tradingsymbol,
    exchange: 'ETORO',
    symbol: label,
    instrument_display_name: label,
  }
}

function isTargetOnFeed(
  watchlists: Watchlist[],
  accountEnv: 'demo' | 'live',
  target: PositionFeedTarget,
): boolean {
  const token = target.symboltoken.trim()
  if (token && isSymbolOnWatchlistFeed(watchlists, {
    broker: 'etoro',
    account_env: accountEnv,
    token,
  })) {
    return true
  }
  const symbol = target.tradingsymbol.trim() || target.symbol?.trim() || ''
  if (!symbol) return false
  return isSymbolOnWatchlistFeed(watchlists, {
    broker: 'etoro',
    account_env: accountEnv,
    symbol,
  })
}

function resolvePositionsFeedWatchlist(
  watchlists: Watchlist[],
  accountEnv: 'demo' | 'live',
): Watchlist | undefined {
  return watchlists.find(
    wl =>
      wl.broker === 'etoro'
      && wl.account_env === accountEnv
      && wl.name === POSITIONS_FEED_WATCHLIST,
  ) ?? watchlists.find(
    wl => wl.broker === 'etoro' && wl.account_env === accountEnv,
  ) ?? watchlists.find(wl => wl.broker === 'etoro')
}

/** Ensure every open position is on the shared eToro watchlist websocket feed. */
export function useEnsurePositionWatchlistFeed(
  accountEnv: 'demo' | 'live',
  targets: PositionFeedTarget[],
) {
  const { watchlists, setWatchlists, watchlistsReady } = useWatchlistStream()
  const attachingRef = useRef(new Set<string>())
  const watchlistsRef = useRef(watchlists)

  useEffect(() => {
    watchlistsRef.current = watchlists
  }, [watchlists])

  const uniqueTargets = useMemo(() => {
    const seen = new Set<string>()
    const out: PositionFeedTarget[] = []
    for (const target of targets) {
      const token = target.symboltoken.trim()
      if (!token || seen.has(token)) continue
      seen.add(token)
      out.push({
        symboltoken: token,
        tradingsymbol: target.tradingsymbol.trim() || token,
        symbol: target.symbol?.trim() || null,
      })
    }
    return out
  }, [targets])

  useEffect(() => {
    if (!watchlistsReady || uniqueTargets.length === 0) return undefined

    let cancelled = false

    const ensureFeed = async () => {
      let target = resolvePositionsFeedWatchlist(watchlistsRef.current, accountEnv)

      for (const row of uniqueTargets) {
        if (cancelled) return
        const attachKey = row.symboltoken
        if (attachingRef.current.has(attachKey)) continue
        if (isTargetOnFeed(watchlistsRef.current, accountEnv, row)) continue

        attachingRef.current.add(attachKey)
        try {
          if (!target) {
            target = await createWatchlist(POSITIONS_FEED_WATCHLIST, {
              broker: 'etoro',
              account_env: accountEnv,
            })
            if (cancelled) return
            setWatchlists(prev => (prev.some(wl => wl.id === target!.id) ? prev : [...prev, target!]))
          }

          const exists = target.symbols.some(symbol => symbol.symboltoken === row.symboltoken)
          if (exists) continue

          const payload = targetToSymbolPayload(row)
          const updated = await addWatchlistSymbol(target.id, payload)
          if (cancelled) return
          setWatchlists(prev => prev.map(wl => (wl.id === target!.id ? updated : wl)))
          watchlistsRef.current = watchlistsRef.current.map(wl => (wl.id === target!.id ? updated : wl))
          target = updated
        } catch {
          if (row.tradingsymbol.trim()) {
            try {
              const hits = await searchWatchlistSymbol('etoro', row.tradingsymbol, accountEnv)
              const hit = pickWatchlistSymbolMatch(hits, row.tradingsymbol) ?? hits[0]
              if (!hit || cancelled || !target) continue
              const updated = await addWatchlistSymbol(target.id, hitToSymbolPayload(hit))
              if (cancelled) return
              setWatchlists(prev => prev.map(wl => (wl.id === target!.id ? updated : wl)))
              watchlistsRef.current = watchlistsRef.current.map(wl => (wl.id === target!.id ? updated : wl))
              target = updated
            } catch {
              // Retry on next interval.
            }
          }
        } finally {
          attachingRef.current.delete(attachKey)
        }
      }
    }

    void ensureFeed()
    const retryId = window.setInterval(() => {
      void ensureFeed()
    }, RETRY_MS)

    return () => {
      cancelled = true
      window.clearInterval(retryId)
    }
  }, [accountEnv, setWatchlists, uniqueTargets, watchlistsReady])
}
