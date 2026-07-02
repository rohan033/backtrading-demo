import { useEffect, useState } from 'react'

import {
  defaultAccountEnv,
  pickWatchlistSymbolMatch,
  searchWatchlistSymbol,
  type WatchlistBroker,
} from '@/lib/watchlistBrokers'

type Params = {
  symbol: string | null | undefined
  token?: string | null
  exchange?: string | null
  broker?: WatchlistBroker
  accountEnv?: 'live' | 'demo'
}

/**
 * Resolves broker instrument id (token) when only a ticker is known.
 */
export function useResolvedInstrument({
  symbol,
  token,
  exchange,
  broker = 'etoro',
  accountEnv,
}: Params) {
  const env = accountEnv || defaultAccountEnv(broker)
  const [resolvedToken, setResolvedToken] = useState<string | null>(token ? String(token) : null)
  const [resolvedExchange, setResolvedExchange] = useState(
    exchange || (broker === 'etoro' ? 'ETORO' : 'NSE'),
  )
  const [resolving, setResolving] = useState(false)

  useEffect(() => {
    const sym = String(symbol || '').trim()
    if (!sym) {
      setResolvedToken(null)
      setResolving(false)
      return
    }

    let cancelled = false
    setResolving(true)

    void searchWatchlistSymbol(broker, sym, env).then(hits => {
      if (cancelled) return
      const hit = pickWatchlistSymbolMatch(hits, sym)
      if (hit) {
        setResolvedToken(hit.symboltoken)
        setResolvedExchange(hit.exchange || (broker === 'etoro' ? 'ETORO' : 'NSE'))
      } else if (token) {
        setResolvedToken(String(token))
        setResolvedExchange(exchange || (broker === 'etoro' ? 'ETORO' : 'NSE'))
      } else {
        setResolvedToken(null)
      }
      setResolving(false)
    }).catch(() => {
      if (!cancelled) {
        if (token) {
          setResolvedToken(String(token))
          setResolvedExchange(exchange || (broker === 'etoro' ? 'ETORO' : 'NSE'))
        }
        setResolving(false)
      }
    })

    return () => {
      cancelled = true
    }
  }, [broker, env, exchange, symbol, token])

  return {
    token: resolvedToken,
    exchange: resolvedExchange,
    resolving,
    ready: Boolean(symbol && (resolvedToken || (broker === 'angel' && symbol))),
  }
}
