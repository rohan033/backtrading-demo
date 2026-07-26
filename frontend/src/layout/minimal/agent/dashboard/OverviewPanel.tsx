import type { AgenticLivePortfolio } from '@/hooks/useAgenticLivePortfolio'
import type { AgenticSessionSnapshot } from '@/lib/agenticSessions'
import { Panel, money, pnlClass } from './shared'

function formatPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  return `${sign}${Math.abs(value).toFixed(2)}%`
}

export default function OverviewPanel({
  portfolio,
  live,
}: {
  portfolio: AgenticSessionSnapshot['portfolio']
  live: AgenticLivePortfolio
}) {
  const winRate = portfolio.win_rate == null ? '—' : `${(portfolio.win_rate * 100).toFixed(1)}%`
  const trades = portfolio.trades_taken ?? portfolio.open_positions ?? 0
  const totalPnl = live.totalPnl
  const totalPct = live.totalPnlPct

  return (
    <Panel title="Overview" bodyClassName="ags-overview__body">
      <div className="ags-overview">
        <div className="ags-bignum ags-bignum--hero">
          <span className="ags-bignum__label">
            Profit / Loss
            {live.hasLiveMarks ? (
              <span className="ags-bignum__live-tag" title="Includes live mark-to-market on open positions">
                live
              </span>
            ) : null}
          </span>
          <strong className={`ags-bignum__value ags-bignum__value--hero ${pnlClass(totalPnl)}`}>
            {money(totalPnl, true)}
          </strong>
          {totalPct != null ? (
            <span className={`ags-bignum__pct ${pnlClass(totalPct)}`}>
              {formatPct(totalPct)}
              <span className="ags-bignum__pct-hint"> of start balance</span>
            </span>
          ) : null}
        </div>
        <div className="ags-bignum">
          <span className="ags-bignum__label">Open unrealized</span>
          <strong className={`ags-bignum__value ${pnlClass(live.openUnrealized)}`}>
            {money(live.openUnrealized, true)}
          </strong>
        </div>
        <div className="ags-bignum">
          <span className="ags-bignum__label">Realized (closed)</span>
          <strong className={`ags-bignum__value ${pnlClass(live.realizedPnl)}`}>
            {money(live.realizedPnl, true)}
          </strong>
        </div>
        <div className="ags-bignum">
          <span className="ags-bignum__label">Amount invested</span>
          <strong className="ags-bignum__value">{money(portfolio.invested)}</strong>
        </div>
        <div className="ags-bignum">
          <span className="ags-bignum__label">Total trades taken</span>
          <strong className="ags-bignum__value">{trades}</strong>
        </div>
        <div className="ags-bignum">
          <span className="ags-bignum__label">Current win rate</span>
          <strong className="ags-bignum__value">{winRate}</strong>
        </div>
      </div>
    </Panel>
  )
}
