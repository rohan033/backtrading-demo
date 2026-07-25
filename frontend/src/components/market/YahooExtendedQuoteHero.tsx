import type { ReactNode } from 'react'

import { useYahooExtendedQuote } from '../../hooks/useYahooExtendedQuotes'
import { YahooExtendedMetrics } from './YahooExtendedMetrics'

type Props = {
  ticker: string
  enabled: boolean
  generation?: number
  active?: boolean
  staggerMs?: number
  compact?: boolean
  className?: string
  children: ReactNode
}

export function YahooExtendedQuoteHero({
  ticker,
  enabled,
  generation = 0,
  active = true,
  staggerMs = 0,
  compact = false,
  className,
  children,
}: Props) {
  const { quote, previousPct, useYahooQuote } = useYahooExtendedQuote(ticker, {
    enabled,
    generation,
    active,
    staggerMs,
  })

  if (useYahooQuote && quote) {
    return (
      <div className={className}>
        <YahooExtendedMetrics quote={quote} previousPct={previousPct} compact={compact} />
      </div>
    )
  }

  return <>{children}</>
}
