import { useEffect, useMemo, useState } from 'react'

import { useWatchlistStream } from '../context/WatchlistStreamContext'
import {
  resolveWatchlistSymbolRef,
  resolveWatchlistTickKey,
  shouldReuseWatchlistFeed,
} from '../lib/watchlistFeedReuse'
import { useControlMarketStream, type MarketStreamStatus } from '../lib/useControlMarketStream'

const STALE_MS = 15000
const REUSE_FALLBACK_MS = 8000

type Params = {
  broker: string
  token?: string | number | null
  symbol?: string | null
  exchange?: string
  account_env?: string
  use_fake_client?: boolean
  feed_mode?: string
  enabled?: boolean
}

function watchlistStreamStatus(
  connected: boolean,
  lastTickAt: number | null,
  nowMs: number,
): MarketStreamStatus {
  if (!connected) {
    return { status: 'connecting', label: 'Watchlist feed connecting…', tone: 'warn' }
  }
  if (!lastTickAt) {
    return { status: 'waiting', label: 'Watchlist feed — waiting for tick…', tone: 'warn' }
  }
  const ageMs = nowMs - lastTickAt
  if (ageMs > STALE_MS) {
    const ageSec = Math.max(0, Math.round(ageMs / 1000))
    return { status: 'stale', label: `Watchlist feed stale (${ageSec}s)`, tone: 'error' }
  }
  return { status: 'flowing', label: 'Live', tone: 'ok' }
}

/**
 * Market preview that reuses the shared /ws/watchlist feed when the symbol is
 * already subscribed there, instead of opening a second control-plane socket.
 */
export function useMarketPreviewFeed({
  broker,
  token,
  symbol,
  exchange,
  account_env,
  use_fake_client,
  feed_mode,
  enabled = true,
}: Params) {
  const { watchlists, ticks, connected } = useWatchlistStream()
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [lastTickAt, setLastTickAt] = useState<number | null>(null)
  const [reuseFallback, setReuseFallback] = useState(false)

  const lookup = useMemo(
    () => ({ broker, account_env, token, symbol }),
    [broker, account_env, token, symbol],
  )

  const watchlistRef = useMemo(
    () =>
      enabled && token && symbol
        ? resolveWatchlistSymbolRef(watchlists, lookup)
        : null,
    [enabled, token, symbol, watchlists, lookup],
  )

  const reuseWatchlist = useMemo(
    () =>
      Boolean(
        enabled
        && token
        && symbol
        && shouldReuseWatchlistFeed(watchlists, connected, lookup),
      ),
    [enabled, token, symbol, watchlists, connected, lookup],
  )

  const tickKey = useMemo(
    () => (reuseWatchlist ? resolveWatchlistTickKey(watchlists, lookup) : null),
    [reuseWatchlist, watchlists, lookup],
  )

  const watchlistLtp = tickKey ? ticks[tickKey]?.ltp ?? null : null

  useEffect(() => {
    setReuseFallback(false)
    setLastTickAt(null)
  }, [tickKey, symbol, token, broker, account_env])

  useEffect(() => {
    if (!reuseWatchlist || watchlistLtp != null) {
      setReuseFallback(false)
      return undefined
    }
    const id = window.setTimeout(() => setReuseFallback(true), REUSE_FALLBACK_MS)
    return () => window.clearTimeout(id)
  }, [reuseWatchlist, watchlistLtp, tickKey])

  useEffect(() => {
    if (watchlistLtp == null) return
    setLastTickAt(Date.now())
  }, [watchlistLtp, tickKey])

  useEffect(() => {
    if (!reuseWatchlist) {
      return undefined
    }
    const id = window.setInterval(() => setNowMs(Date.now()), 5000)
    return () => window.clearInterval(id)
  }, [reuseWatchlist])

  const useDedicatedStream = Boolean(
    enabled
    && symbol
    && (!reuseWatchlist || reuseFallback),
  )

  const controlStream = useControlMarketStream(
    useDedicatedStream
      ? {
          broker,
          token: String(token || symbol),
          symbol: String(symbol),
          exchange: exchange || (broker === 'etoro' ? 'ETORO' : 'NSE'),
          account_env: watchlistRef?.accountEnv || account_env,
          use_fake_client,
          feed_mode,
        }
      : null,
    useDedicatedStream,
  )

  useEffect(() => {
    if (!useDedicatedStream || controlStream.ltp == null) return
    setLastTickAt(Date.now())
  }, [useDedicatedStream, controlStream.ltp])

  const effectiveLtp = watchlistLtp ?? (useDedicatedStream ? controlStream.ltp : null)

  const streamStatus = useMemo((): MarketStreamStatus => {
    if (!enabled || !symbol) {
      return { status: 'idle', label: 'Select a stock to preview', tone: 'muted' }
    }
    if (reuseWatchlist && !reuseFallback) {
      if (!connected) {
        return { status: 'connecting', label: 'Connecting to watchlist feed…', tone: 'warn' }
      }
      if (!lastTickAt) {
        return { status: 'waiting', label: 'Watchlist feed — waiting for first tick…', tone: 'warn' }
      }
      return watchlistStreamStatus(connected, lastTickAt, nowMs)
    }
    return controlStream.streamStatus
  }, [
    enabled,
    token,
    symbol,
    reuseWatchlist,
    reuseFallback,
    connected,
    lastTickAt,
    nowMs,
    controlStream.streamStatus,
  ])

  return {
    ltp: effectiveLtp,
    connected: reuseWatchlist && !reuseFallback ? connected : controlStream.connected,
    marketError: reuseWatchlist && !reuseFallback ? '' : controlStream.error,
    streamStatus,
    reusingWatchlistFeed: reuseWatchlist && !reuseFallback,
  }
}
