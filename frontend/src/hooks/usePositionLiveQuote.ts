import { useEffect, useMemo, useState } from 'react'

import { useWatchlistStream } from '@/context/WatchlistStreamContext'
import { resolvePositionTickKey } from '@/lib/watchlistFeedReuse'

const WS_STALE_MS = 15000

export type PositionLiveQuote = {
  mark: number | null
  pnl: number | null
  pnlPct: number
  live: boolean
  stale: boolean
  statusLabel: string
}

/** Live mark/P&L from the shared watchlist websocket — same feed as Watch & Trade. */
export function usePositionLiveQuote(params: {
  accountEnv: 'demo' | 'live'
  symboltoken: string
  tradingsymbol: string
  ticker: string
  openRate: number
  quantity: number
  isBuy: boolean
  brokerLtp: number | null
  brokerPnl: number | null
}): PositionLiveQuote {
  const { watchlists, ticks, connected } = useWatchlistStream()
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [lastTickAt, setLastTickAt] = useState<number | null>(null)

  const tickKey = useMemo(
    () =>
      resolvePositionTickKey(watchlists, {
        account_env: params.accountEnv,
        symboltoken: params.symboltoken,
        symbol: params.tradingsymbol || params.ticker,
      }),
    [watchlists, params.accountEnv, params.symboltoken, params.tradingsymbol, params.ticker],
  )

  const tick = tickKey ? ticks[tickKey] : undefined
  const watchlistLtp = tick?.ltp ?? null

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 5000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    setLastTickAt(null)
  }, [tickKey])

  useEffect(() => {
    if (tick?.ltp != null && tick.ltp > 0) {
      setLastTickAt(Date.now())
    }
  }, [tick, tickKey])

  const live = Boolean(
    connected
    && watchlistLtp != null
    && watchlistLtp > 0
    && lastTickAt != null
    && nowMs - lastTickAt <= WS_STALE_MS,
  )

  // Watchlist websocket wins when fresh — REST /pnl can lag 10s+ behind the shared feed.
  const mark = live
    ? watchlistLtp
    : (params.brokerLtp ?? watchlistLtp ?? null)

  const direction = params.isBuy ? 1 : -1
  const pnlFromMark =
    mark != null && params.openRate > 0 && params.quantity > 0
      ? (mark - params.openRate) * params.quantity * direction
      : null
  const pnlPctFromMark =
    mark != null && params.openRate > 0
      ? ((mark - params.openRate) / params.openRate) * 100 * direction
      : 0

  const pnl = live
    ? (pnlFromMark ?? params.brokerPnl)
    : (params.brokerPnl ?? pnlFromMark)

  const stale = !live && mark != null
  const statusLabel = live
    ? 'Live watchlist feed'
    : connected
      ? 'Using eToro /pnl mark — watchlist tick pending'
      : 'Watchlist feed connecting…'

  return {
    mark,
    pnl,
    pnlPct: pnlPctFromMark,
    live,
    stale,
    statusLabel,
  }
}
