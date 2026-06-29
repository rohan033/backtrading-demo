import { useEffect, useMemo, useState } from 'react'

import { useWatchlistStream } from '../context/WatchlistStreamContext'
import { defaultAccountEnv } from '../lib/watchlistBrokers'
import { shouldReuseWatchlistFeed } from '../lib/watchlistFeedReuse'
import { useControlMarketStream, type MarketStreamStatus } from '../lib/useControlMarketStream'
import { watchlistTickKey } from '../lib/watchlists'

const STALE_MS = 15000

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

  const reuseWatchlist = useMemo(
    () =>
      Boolean(
        enabled
        && token
        && symbol
        && shouldReuseWatchlistFeed(watchlists, connected, {
          broker,
          account_env,
          token,
          symbol,
        }),
      ),
    [enabled, token, symbol, watchlists, connected, broker, account_env],
  )

  const tickKey = useMemo(() => {
    if (!reuseWatchlist || !token) return null
    const env = account_env || defaultAccountEnv(broker === 'etoro' ? 'etoro' : 'angel')
    return watchlistTickKey(broker, env, String(token))
  }, [reuseWatchlist, broker, account_env, token])

  const watchlistLtp = tickKey ? ticks[tickKey]?.ltp ?? null : null

  useEffect(() => {
    if (!reuseWatchlist || watchlistLtp == null) return
    setLastTickAt(Date.now())
  }, [reuseWatchlist, watchlistLtp, tickKey])

  useEffect(() => {
    if (!reuseWatchlist) {
      setLastTickAt(null)
      return undefined
    }
    const id = window.setInterval(() => setNowMs(Date.now()), 5000)
    return () => window.clearInterval(id)
  }, [reuseWatchlist])

  const controlStream = useControlMarketStream(
    enabled && !reuseWatchlist && symbol
      ? {
          broker,
          token: String(token || symbol),
          symbol: String(symbol),
          exchange: exchange || (broker === 'etoro' ? 'ETORO' : 'NSE'),
          account_env,
          use_fake_client,
          feed_mode,
        }
      : null,
    enabled && !reuseWatchlist,
  )

  const streamStatus = useMemo((): MarketStreamStatus => {
    if (!enabled || !token || !symbol) {
      return { status: 'idle', label: 'Select a stock to preview', tone: 'muted' }
    }
    if (reuseWatchlist) {
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
    connected,
    lastTickAt,
    nowMs,
    controlStream.streamStatus,
  ])

  return {
    ltp: reuseWatchlist ? watchlistLtp : controlStream.ltp,
    connected: reuseWatchlist ? connected : controlStream.connected,
    marketError: reuseWatchlist ? '' : controlStream.error,
    streamStatus,
    reusingWatchlistFeed: reuseWatchlist,
  }
}
