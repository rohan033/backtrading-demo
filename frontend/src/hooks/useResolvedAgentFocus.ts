import { useEffect, useState } from 'react'

import type { AgentThread, AgentThreadFocus } from '@/lib/agentThreads'
import {
  defaultAccountEnv,
  pickWatchlistSymbolMatch,
  searchWatchlistSymbol,
  type WatchlistBroker,
} from '@/lib/watchlistBrokers'

/**
 * Ensures focus has a broker instrument id (token) when only a ticker is present.
 * Accepts an optional reconciled focus (e.g. from running execution) that overrides metadata.
 */
export function useResolvedAgentFocus(
  thread: AgentThread | null,
  overrideFocus?: AgentThreadFocus | null,
): AgentThreadFocus | null {
  const focus = overrideFocus ?? null
  const [resolved, setResolved] = useState<AgentThreadFocus | null>(focus)

  useEffect(() => {
    if (!focus?.symbol) {
      setResolved(null)
      return
    }

    const broker = (focus.broker || 'etoro') as WatchlistBroker
    const accountEnv = focus.account_env || defaultAccountEnv(broker)

    if (focus.token) {
      setResolved({
        ...focus,
        broker,
        account_env: accountEnv,
        exchange: focus.exchange || (broker === 'etoro' ? 'ETORO' : 'NSE'),
      })
      return
    }

    let cancelled = false
    setResolved({ ...focus, broker, account_env: accountEnv })

    void searchWatchlistSymbol(broker, focus.symbol, accountEnv).then(hits => {
      if (cancelled) return
      const hit = pickWatchlistSymbolMatch(hits, focus.symbol!)
      if (!hit) return
      setResolved(prev => ({
        ...(prev || focus),
        token: hit.symboltoken,
        exchange: hit.exchange || prev?.exchange || 'ETORO',
        broker,
        account_env: accountEnv,
      }))
    })

    return () => {
      cancelled = true
    }
  }, [
    focus?.account_env,
    focus?.broker,
    focus?.close_price,
    focus?.exchange,
    focus?.execution_id,
    focus?.initial_threshold,
    focus?.long_percent,
    focus?.max_available_capital,
    focus?.short_percent,
    focus?.symbol,
    focus?.token,
  ])

  return resolved
}
