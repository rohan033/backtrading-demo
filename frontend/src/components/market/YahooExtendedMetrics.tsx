import {
  formatHomeMoverAbs,
  formatHomeMoverPct,
  formatHomeMoverPrice,
  homeMoverPctArrow,
  homeMoverPctTone,
  type HomeMoverMetrics,
} from '../../lib/homeMarketMovers'
import type { YahooExtendedQuote } from '../../lib/yahooFinanceApi'
import { yahooQuoteMetrics } from '../../lib/yahooFinanceApi'
import './YahooExtendedMetrics.css'

export { yahooQuoteMetrics }

export function yahooQuoteToMoverMetrics(quote: YahooExtendedQuote): HomeMoverMetrics {
  return yahooQuoteMetrics(quote)
}

type Props = {
  quote: YahooExtendedQuote
  previousPct?: number | null
  compact?: boolean
}

export function YahooExtendedMetrics({ quote, previousPct, compact = false }: Props) {
  const metrics = yahooQuoteMetrics(quote)
  const tone = homeMoverPctTone(metrics.pct)
  const arrow = homeMoverPctArrow(metrics.pct, previousPct)

  return (
    <>
      <div className={`yahoo-ext__pct-row${compact ? ' yahoo-ext__pct-row--compact' : ''}`}>
        <div className={`yahoo-ext__pct yahoo-ext__pct--${tone}`}>
          {formatHomeMoverPct(metrics.pct)}
        </div>
        {arrow === 'up' ? (
          <span className="yahoo-ext__arrow yahoo-ext__arrow--up" title="Change % increased since last refresh" aria-hidden>↑</span>
        ) : null}
        {arrow === 'down' ? (
          <span className="yahoo-ext__arrow yahoo-ext__arrow--down" title="Change % decreased since last refresh" aria-hidden>↓</span>
        ) : null}
        {arrow === 'flat' ? (
          <span className="yahoo-ext__arrow yahoo-ext__arrow--flat" title="Change % unchanged since last refresh" aria-hidden>→</span>
        ) : null}
      </div>
      <div className="yahoo-ext__meta">
        <span className="yahoo-ext__price">{formatHomeMoverPrice(metrics.price)}</span>
        <span className={`yahoo-ext__abs yahoo-ext__abs--${tone}`}>
          {formatHomeMoverAbs(metrics.changeAbs)}
        </span>
      </div>
      <div className="yahoo-ext__tag" title="Yahoo Finance extended hours vs prior close">
        YF · {quote.session}
      </div>
    </>
  )
}
