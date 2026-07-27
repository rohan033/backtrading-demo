import { useEffect, useMemo, useRef, useState } from 'react'

import { useWatchlistStream } from '@/context/WatchlistStreamContext'
import type { AgenticSessionPosition } from '@/lib/agenticSessions'
import {
  pickWatchlistSymbolMatch,
  searchWatchlistSymbol,
  type WatchlistSymbolHit,
} from '@/lib/watchlistBrokers'
import {
  isSymbolOnWatchlistFeed,
  resolveEtoroLiveTickKey,
} from '@/lib/watchlistFeedReuse'
import { addWatchlistSymbol, createWatchlist } from '@/lib/watchlists'

const AGENTIC_FEED_WATCHLIST = 'Agentic feed'
const WS_STALE_MS = 15000

export type AgenticPositionLiveQuote = {
  mark: number | null
  live: boolean
  flash: 'up' | 'down' | null
  unrealizedPnl: number | null
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

/** Attach open position tickers to the shared eToro watchlist feed and resolve live marks. */
export function useAgenticPositionLiveFeed(
  accountEnv: 'demo' | 'live',
  positions: AgenticSessionPosition[],
): Record<string, AgenticPositionLiveQuote> {
  const { watchlists, setWatchlists, watchlistsReady, ticks, connected } = useWatchlistStream()
  const attachingRef = useRef(new Set<string>())
  const prevLtpRef = useRef<Record<string, number>>({})
  const tickSeenAtRef = useRef<Record<string, number>>({})
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 5000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    const seenAt = Date.now()
    for (const position of positions) {
      const ticker = position.ticker.toUpperCase()
      const tickKey = resolveEtoroLiveTickKey(watchlists, ticker, accountEnv)
      if (tickKey && ticks[tickKey]?.ltp != null) {
        tickSeenAtRef.current[ticker] = seenAt
      }
    }
  }, [accountEnv, positions, ticks, watchlists])

  const tickers = useMemo(
    () => [...new Set(positions.map(position => position.ticker.toUpperCase()))],
    [positions],
  )

  useEffect(() => {
    if (!watchlistsReady || tickers.length === 0) return

    let cancelled = false

    const ensureFeed = async () => {
      let target = watchlists.find(
        wl => wl.broker === 'etoro' && wl.account_env === accountEnv,
      )
      if (!target) {
        target = watchlists.find(wl => wl.broker === 'etoro')
      }

      for (const ticker of tickers) {
        if (cancelled) return
        if (attachingRef.current.has(ticker)) continue
        if (isSymbolOnWatchlistFeed(watchlists, {
          broker: 'etoro',
          account_env: accountEnv,
          symbol: ticker,
        })) {
          continue
        }

        attachingRef.current.add(ticker)
        try {
          if (!target) {
            target = await createWatchlist(AGENTIC_FEED_WATCHLIST, {
              broker: 'etoro',
              account_env: accountEnv,
            })
            if (cancelled) return
            setWatchlists(prev => (prev.some(wl => wl.id === target!.id) ? prev : [...prev, target!]))
          }

          const hits = await searchWatchlistSymbol('etoro', ticker, accountEnv)
          const hit = pickWatchlistSymbolMatch(hits, ticker) ?? hits[0]
          if (!hit || cancelled) continue

          const exists = target.symbols.some(
            symbol =>
              symbol.tradingsymbol.toUpperCase() === hit.tradingsymbol.toUpperCase()
              || symbol.symboltoken === hit.symboltoken,
          )
          if (exists) continue

          const updated = await addWatchlistSymbol(target.id, hitToSymbolPayload(hit))
          if (cancelled) return
          setWatchlists(prev => prev.map(wl => (wl.id === target!.id ? updated : wl)))
          target = updated
        } catch {
          // Best-effort — snapshot prices remain the fallback.
        } finally {
          attachingRef.current.delete(ticker)
        }
      }
    }

    void ensureFeed()
    return () => {
      cancelled = true
    }
  }, [accountEnv, setWatchlists, tickers, watchlists, watchlistsReady])

  return useMemo(() => {
    const map: Record<string, AgenticPositionLiveQuote> = {}
    for (const position of positions) {
      const ticker = position.ticker.toUpperCase()
      const tickKey = resolveEtoroLiveTickKey(watchlists, ticker, accountEnv)
      const tick = tickKey ? ticks[tickKey] : undefined
      const liveLtp = tick?.ltp ?? null
      const seenAt = tickSeenAtRef.current[ticker]
      const wsFresh =
        liveLtp != null
        && seenAt != null
        && nowMs - seenAt <= WS_STALE_MS
      const live = wsFresh && connected

      let flash: 'up' | 'down' | null = null
      if (wsFresh && liveLtp != null) {
        const prev = prevLtpRef.current[ticker]
        if (prev != null && liveLtp !== prev) {
          flash = liveLtp > prev ? 'up' : 'down'
        }
        prevLtpRef.current[ticker] = liveLtp
      }

      const mark = wsFresh
        ? liveLtp
        : (position.current_price ?? liveLtp ?? null)
      const units = Number(position.units) || 0
      const buy = Number(position.buy_price) || 0
      const unrealizedPnl =
        mark != null && units > 0 && buy > 0
          ? (mark - buy) * units
          : position.unrealized_pnl

      map[ticker] = {
        mark,
        live,
        flash,
        unrealizedPnl,
      }
    }
    return map
  }, [accountEnv, connected, nowMs, positions, ticks, watchlists])
}
