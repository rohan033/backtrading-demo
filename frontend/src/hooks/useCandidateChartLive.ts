import { useEffect, useMemo, useRef, useState } from 'react'

import { useMarketPreviewFeed } from '@/hooks/useMarketPreviewFeed'
import { useResolvedInstrument } from '@/hooks/useResolvedInstrument'
import { appendPriceSample, type PriceSample } from '@/lib/watchlistChangeColumns'
import { defaultAccountEnv, type WatchlistBroker } from '@/lib/watchlistBrokers'

const HEARTBEAT_MS = 2_000

type Params = {
  symbol: string
  token?: string | null
  exchange?: string
  broker?: WatchlistBroker
  accountEnv?: 'live' | 'demo'
  enabled?: boolean
}

export function useCandidateChartLive({
  symbol,
  token,
  exchange,
  broker = 'etoro',
  accountEnv,
  enabled = true,
}: Params) {
  const env = accountEnv || defaultAccountEnv(broker)
  const active = enabled && Boolean(String(symbol || '').trim())
  const { token: resolvedToken, exchange: resolvedExchange, ready, resolving } = useResolvedInstrument({
    symbol: active ? symbol : null,
    token,
    exchange,
    broker,
    accountEnv: env,
  })

  const feedToken = resolvedToken || (broker === 'angel' ? symbol : null)
  const feedReady = active && ready

  const { ltp, streamStatus, connected } = useMarketPreviewFeed({
    broker,
    token: feedToken,
    symbol: active ? symbol : null,
    exchange: resolvedExchange,
    account_env: env,
    enabled: feedReady,
  })

  const [samples, setSamples] = useState<PriceSample[]>([])
  const ltpRef = useRef<number | null>(null)
  const lastSampleAtRef = useRef(0)

  useEffect(() => {
    setSamples([])
    ltpRef.current = null
    lastSampleAtRef.current = 0
  }, [feedToken, symbol])

  useEffect(() => {
    if (ltp == null || !Number.isFinite(ltp) || ltp <= 0) return
    ltpRef.current = ltp
    const now = Date.now()
    lastSampleAtRef.current = now
    setSamples(prev => appendPriceSample(prev, ltp, now))
  }, [ltp])

  useEffect(() => {
    if (!feedReady || !connected) return undefined
    const id = window.setInterval(() => {
      const price = ltpRef.current
      if (price == null || !Number.isFinite(price) || price <= 0) return
      const now = Date.now()
      if (now - lastSampleAtRef.current < HEARTBEAT_MS - 100) return
      lastSampleAtRef.current = now
      setSamples(prev => appendPriceSample(prev, price, now))
    }, HEARTBEAT_MS)
    return () => window.clearInterval(id)
  }, [connected, feedReady])

  const tickKey = useMemo(
    () => `${broker}:${env}:${feedToken || symbol}:${resolvedExchange}`,
    [broker, env, feedToken, resolvedExchange, symbol],
  )

  return {
    tickKey,
    feedToken,
    resolvedExchange,
    ltp,
    streamStatus,
    connected,
    samples,
    ready: feedReady,
    resolving: active && resolving,
  }
}
