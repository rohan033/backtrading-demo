import { useMemo } from 'react'

import type { A2uiStockPick } from '@/lib/agentA2uiCatalog'
import type { PriceSample } from '@/lib/watchlistChangeColumns'
import { defaultAccountEnv, type WatchlistBroker } from '@/lib/watchlistBrokers'
import type { AgentThreadFocus } from '@/lib/agentThreads'
import type { MarketStreamStatus } from '@/lib/useControlMarketStream'

import { useCandidateChartLive } from './useCandidateChartLive'

export type CandidateLiveFeed = {
  symbol: string
  tickKey: string
  feedToken: string | null
  resolvedExchange: string
  ltp: number | null
  streamStatus: MarketStreamStatus
  connected: boolean
  samples: PriceSample[]
  resolving: boolean
  focus: AgentThreadFocus
}

export type MonitorWatchTarget = {
  focus: AgentThreadFocus
  ltp: number | null
  dedicatedSamples: PriceSample[]
}

function toLiveFeed(
  pick: A2uiStockPick,
  feed: ReturnType<typeof useCandidateChartLive>,
  broker: WatchlistBroker,
  accountEnv: 'live' | 'demo',
): CandidateLiveFeed {
  const env = accountEnv || defaultAccountEnv(broker)
  return {
    symbol: pick.symbol,
    tickKey: feed.tickKey,
    feedToken: feed.feedToken,
    resolvedExchange: feed.resolvedExchange,
    ltp: feed.ltp,
    streamStatus: feed.streamStatus,
    connected: feed.connected,
    samples: feed.samples,
    resolving: feed.resolving,
    focus: {
      symbol: pick.symbol,
      token: feed.feedToken,
      exchange: feed.resolvedExchange,
      broker,
      account_env: env,
    },
  }
}

/** Live feeds for up to 3 compare-candidate symbols (one WebSocket per symbol). */
export function useMultiSymbolLiveFeeds(
  picks: A2uiStockPick[] | null | undefined,
  broker: WatchlistBroker,
  accountEnv: 'live' | 'demo',
) {
  const list = picks?.slice(0, 3) ?? []
  const pick0 = list[0]
  const pick1 = list[1]
  const pick2 = list[2]

  const feed0 = useCandidateChartLive({
    symbol: String(pick0?.symbol || '').trim(),
    token: pick0?.token,
    exchange: pick0?.exchange,
    broker,
    accountEnv,
    enabled: Boolean(pick0?.symbol),
  })
  const feed1 = useCandidateChartLive({
    symbol: String(pick1?.symbol || '').trim(),
    token: pick1?.token,
    exchange: pick1?.exchange,
    broker,
    accountEnv,
    enabled: Boolean(pick1?.symbol),
  })
  const feed2 = useCandidateChartLive({
    symbol: String(pick2?.symbol || '').trim(),
    token: pick2?.token,
    exchange: pick2?.exchange,
    broker,
    accountEnv,
    enabled: Boolean(pick2?.symbol),
  })

  return useMemo(() => {
    const feeds: CandidateLiveFeed[] = []
    const targets: MonitorWatchTarget[] = []
    const bySymbol: Record<string, CandidateLiveFeed> = {}

    const pairs: Array<[A2uiStockPick | undefined, ReturnType<typeof useCandidateChartLive>]> = [
      [pick0, feed0],
      [pick1, feed1],
      [pick2, feed2],
    ]

    for (const [pick, feed] of pairs) {
      if (!pick?.symbol) continue
      const row = toLiveFeed(pick, feed, broker, accountEnv)
      feeds.push(row)
      bySymbol[pick.symbol.toUpperCase()] = row
      targets.push({
        focus: row.focus,
        ltp: row.ltp,
        dedicatedSamples: row.samples,
      })
    }

    return { feeds, bySymbol, watchTargets: targets }
  }, [accountEnv, broker, feed0, feed1, feed2, pick0, pick1, pick2])
}
