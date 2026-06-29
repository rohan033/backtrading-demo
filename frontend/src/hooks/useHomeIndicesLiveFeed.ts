import { useMemo } from 'react'

import { HOME_INDEX_DEFINITIONS, type HomeIndexSymbol } from '../lib/homeIndices'
import type { MarketStreamStatus } from '../lib/useControlMarketStream'
import type { WatchlistBroker } from '../lib/watchlistBrokers'
import { useMarketPreviewFeed } from './useMarketPreviewFeed'

const INDEX_IDS = HOME_INDEX_DEFINITIONS.map(definition => definition.id)

function aggregateStreamStatus(statuses: MarketStreamStatus[]): MarketStreamStatus {
  const active = statuses.filter(status => status.status !== 'idle')
  if (!active.length) {
    return { status: 'idle', label: 'Waiting for indices…', tone: 'muted' }
  }

  const flowing = active.filter(status => status.status === 'flowing')
  if (flowing.length === active.length) {
    return { status: 'flowing', label: 'Live', tone: 'ok' }
  }
  if (flowing.length > 0) {
    return {
      status: 'partial',
      label: `Live (${flowing.length}/${active.length})`,
      tone: 'warn',
    }
  }

  const error = active.find(status => status.tone === 'error')
  if (error) return error

  const warn = active.find(status => status.tone === 'warn')
  if (warn) return warn

  return active[0]
}

function useIndexPreviewFeed(
  index: HomeIndexSymbol | undefined,
  broker: WatchlistBroker,
  accountEnv: string,
  enabled: boolean,
) {
  return useMarketPreviewFeed({
    broker,
    token: index?.symboltoken,
    symbol: index?.tradingsymbol,
    exchange: index?.exchange,
    account_env: accountEnv,
    feed_mode: 'websocket',
    enabled: enabled && Boolean(index),
  })
}

export function useHomeIndicesLiveFeed(
  indices: HomeIndexSymbol[],
  broker: WatchlistBroker,
  accountEnv: string,
  enabled = true,
) {
  const byId = useMemo(() => {
    const map = new Map<string, HomeIndexSymbol>()
    for (const index of indices) map.set(index.id, index)
    return map
  }, [indices])

  const spxFeed = useIndexPreviewFeed(byId.get('spx500'), broker, accountEnv, enabled)
  const nsdqFeed = useIndexPreviewFeed(byId.get('nsdq100'), broker, accountEnv, enabled)
  const djFeed = useIndexPreviewFeed(byId.get('dj30'), broker, accountEnv, enabled)

  const feedsById = useMemo(
    () => ({
      spx500: spxFeed,
      nsdq100: nsdqFeed,
      dj30: djFeed,
    }),
    [spxFeed, nsdqFeed, djFeed],
  )

  const ltps = useMemo(() => {
    const next: Record<string, number | null> = {}
    for (const id of INDEX_IDS) {
      next[id] = byId.has(id) ? feedsById[id as keyof typeof feedsById].ltp : null
    }
    return next
  }, [byId, feedsById])

  const streamStatus = useMemo(() => {
    const statuses = INDEX_IDS
      .filter(id => byId.has(id))
      .map(id => feedsById[id as keyof typeof feedsById].streamStatus)
    return aggregateStreamStatus(statuses)
  }, [byId, feedsById])

  return { ltps, streamStatus }
}
