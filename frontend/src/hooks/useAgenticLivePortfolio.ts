import { useMemo } from 'react'

import type { AgenticSessionPosition, AgenticSessionSnapshot } from '@/lib/agenticSessions'
import {
  useAgenticPositionLiveFeed,
  type AgenticPositionLiveQuote,
} from '@/hooks/useAgenticPositionLiveFeed'

export type AgenticLivePortfolio = {
  byTicker: Record<string, AgenticPositionLiveQuote>
  liveUnrealized: number
  realizedPnl: number
  totalPnl: number
  totalPnlPct: number | null
  openUnrealized: number
  hasLiveMarks: boolean
}

export function useAgenticLivePortfolio(
  accountEnv: 'demo' | 'live',
  positions: AgenticSessionPosition[],
  portfolio: AgenticSessionSnapshot['portfolio'],
): AgenticLivePortfolio {
  const byTicker = useAgenticPositionLiveFeed(accountEnv, positions)

  return useMemo(() => {
    const startBalance = Number(portfolio.start_balance) || 0
    const realizedPnl = Number(portfolio.daily_pnl) || 0

    let openUnrealized = 0
    let hasLiveMarks = false
    for (const position of positions) {
      const ticker = position.ticker.toUpperCase()
      const live = byTicker[ticker]
      const mark = live?.mark ?? position.current_price
      const units = Number(position.units) || 0
      const buy = Number(position.buy_price) || 0
      const rowPnl =
        live?.unrealizedPnl ??
        (mark != null && units > 0 ? (mark - buy) * units : position.unrealized_pnl)
      openUnrealized += Number(rowPnl) || 0
      if (live?.live) hasLiveMarks = true
    }

    const totalPnl = realizedPnl + openUnrealized
    const totalPnlPct =
      startBalance > 0 ? (totalPnl / startBalance) * 100 : null

    return {
      byTicker,
      liveUnrealized: openUnrealized,
      realizedPnl,
      totalPnl,
      totalPnlPct,
      openUnrealized,
      hasLiveMarks,
    }
  }, [byTicker, portfolio.daily_pnl, portfolio.start_balance, positions])
}
