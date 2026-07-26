import { formatHomeMoverPct, homeMoverPctTone } from '@/lib/homeMarketMovers'
import type { OverviewTradeSignal } from '@/lib/overviewSignals'
import type { WatchlistSanitizedCandle } from '@/lib/watchlistCandles'
import OverviewMiniCandleChart from '../../OverviewMiniCandleChart'
import { Empty, Panel } from './shared'

/**
 * Market Scanner "just like the home page": reuses the Overview trade-signal
 * builder + the Overview mini candle chart. Tiny cards with symbol, %change and
 * a 5m candle sparkline.
 */
export default function MarketScannerPanel({
  signals,
  candlesBySymbol,
  loading,
  error,
}: {
  signals: OverviewTradeSignal[]
  candlesBySymbol: Record<string, WatchlistSanitizedCandle[]>
  loading: boolean
  error: string
}) {
  return (
    <Panel title="Market Scanner" count={signals.length || undefined} bodyClassName="ags-scan__body">
      {error && signals.length === 0 ? (
        <Empty>{error}</Empty>
      ) : loading && signals.length === 0 ? (
        <Empty>Scanning screeners…</Empty>
      ) : signals.length === 0 ? (
        <Empty>No qualifying movers right now.</Empty>
      ) : (
        <div className="ags-scan-grid">
          {signals.map(signal => {
            const tone = signal.changePct != null ? homeMoverPctTone(signal.changePct) : 'flat'
            return (
              <article key={signal.symbol} className={`ags-scan-card ags-scan-card--${signal.urgency}`}>
                <div className="ags-scan-card__head">
                  <span className="ags-scan-card__symbol">{signal.symbol}</span>
                  <span className="ags-scan-card__score">{signal.score}</span>
                </div>
                {signal.changePct != null ? (
                  <div className={`ags-scan-card__pct ags-scan-card__pct--${tone}`}>
                    {formatHomeMoverPct(signal.changePct)}
                  </div>
                ) : null}
                <OverviewMiniCandleChart candles={candlesBySymbol[signal.symbol] || []} />
              </article>
            )
          })}
        </div>
      )}
    </Panel>
  )
}
