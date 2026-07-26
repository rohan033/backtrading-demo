import type { AgenticMonitorState, AgenticSessionPosition } from '@/lib/agenticSessions'
import type { AgenticPositionLiveQuote } from '@/hooks/useAgenticPositionLiveFeed'
import { formatBrokerMoney } from '@/lib/currency'
import { formatDbTimestamp } from '@/lib/datetime'
import { Empty, Panel, agentGlyph, money, pnlClass } from './shared'

function formatMark(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const digits = value < 1 ? 4 : value < 10 ? 3 : 2
  return formatBrokerMoney('etoro', value, digits)
}

function formatPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  return `${sign}${Math.abs(value).toFixed(2)}%`
}

function windowLabel(plan: AgenticSessionPosition['exit_plan']): string {
  const seconds = plan?.window_seconds
  if (seconds != null && seconds > 0) return `${Math.round(seconds)}s`
  const minutes = plan?.window_minutes
  if (minutes != null && minutes > 0) return `${minutes}m`
  return '30s'
}

export default function ExitPlansPanel({
  positions,
  liveByTicker,
  portfolioMonitor,
}: {
  positions: AgenticSessionPosition[]
  liveByTicker: Record<string, AgenticPositionLiveQuote>
  portfolioMonitor?: AgenticMonitorState
}) {
  const monitorLine = portfolioMonitor?.oneline?.trim()

  return (
    <Panel title="Exit plans" count={positions.length} bodyClassName="ags-exitplans__body">
      {monitorLine ? (
        <p className="ags-exitplans__monitor" title="Portfolio monitor">
          <span className="ags-exitplans__monitor-label">Portfolio monitor</span>
          {monitorLine}
        </p>
      ) : null}

      {positions.length === 0 ? (
        <Empty>No open positions — exit plans appear when positions are held.</Empty>
      ) : (
        <ul className="ags-exitplans">
          {positions.map(position => {
            const ticker = position.ticker.toUpperCase()
            const live = liveByTicker[ticker]
            const mark = live?.mark ?? position.current_price
            const units = Number(position.units) || 0
            const buy = Number(position.buy_price) || 0
            const pnl =
              live?.unrealizedPnl ??
              (mark != null && units > 0 ? (mark - buy) * units : position.unrealized_pnl)
            const plan = position.exit_plan
            const pnlPct = buy > 0 && mark != null ? ((mark - buy) / buy) * 100 : null
            const uptrend = plan?.uptrend_intact
            const uptrendLabel =
              uptrend === true ? 'uptrend intact' : uptrend === false ? 'uptrend broken' : null

            return (
              <li key={position.id} className="ags-exitplan">
                <header className="ags-exitplan__head">
                  <span className="ags-exitplan__icon" aria-hidden>{agentGlyph('exit')}</span>
                  <div className="ags-exitplan__title">
                    <strong>{position.ticker}</strong>
                    <span className={`ags-exit-badge ags-exit-badge--${position.exit_state}`}>
                      {position.exit_state}
                    </span>
                    {uptrendLabel ? (
                      <span
                        className={`ags-exitplan__momentum ags-exitplan__momentum--${
                          uptrend ? 'rising' : 'falling'
                        }`}
                      >
                        {uptrendLabel}
                      </span>
                    ) : plan?.momentum ? (
                      <span className="ags-exitplan__momentum">{plan.momentum}</span>
                    ) : null}
                    {plan?.should_secure ? (
                      <span className="ags-exitplan__secure">secure trigger</span>
                    ) : null}
                  </div>
                  <div className="ags-exitplan__pnl">
                    <span className={`ags-exitplan__pnl-value ${pnlClass(pnl)}`}>{money(pnl, true)}</span>
                    {pnlPct != null ? (
                      <span className={`ags-exitplan__pnl-pct ${pnlClass(pnlPct)}`}>
                        {formatPct(pnlPct)}
                      </span>
                    ) : null}
                  </div>
                </header>

                <div className="ags-exitplan__grid">
                  <div className="ags-exitplan__stat">
                    <span className="ags-exitplan__stat-label">Live</span>
                    <strong>{formatMark(mark)}</strong>
                  </div>
                  <div className="ags-exitplan__stat">
                    <span className="ags-exitplan__stat-label">Entry</span>
                    <strong>{formatMark(buy)}</strong>
                  </div>
                  <div className="ags-exitplan__stat">
                    <span className="ags-exitplan__stat-label">Hard SL</span>
                    <strong className="ags-exitplan__stat--sl">{formatMark(position.stop_loss)}</strong>
                  </div>
                  <div className="ags-exitplan__stat">
                    <span className="ags-exitplan__stat-label">Session peak</span>
                    <strong>{formatMark(plan?.peak_price ?? plan?.recent_high ?? null)}</strong>
                  </div>
                  <div className="ags-exitplan__stat">
                    <span className="ags-exitplan__stat-label">{windowLabel(plan)} high</span>
                    <strong>{formatMark(plan?.recent_high ?? null)}</strong>
                  </div>
                  <div className="ags-exitplan__stat">
                    <span className="ags-exitplan__stat-label">Profit lock</span>
                    <strong className="ags-exitplan__stat--lock">
                      {plan?.profit_lock != null && plan.profit_lock > buy
                        ? formatMark(plan.profit_lock)
                        : '—'}
                    </strong>
                  </div>
                </div>

                {!plan ? (
                  <p className="ags-exitplan__note">
                    Waiting for portfolio monitor — prices stream from websocket, plans refresh every ~30s.
                  </p>
                ) : !plan.active ? (
                  <p className="ags-exitplan__note">
                    Secure logic idle — needs ≥0.35% peak gain above entry
                    {plan.peak_gain_pct != null ? ` (peak ${plan.peak_gain_pct.toFixed(2)}%)` : ''}
                    {plan.sample_count != null ? ` · ${plan.sample_count} tick(s) in ${windowLabel(plan)}` : ''}.
                    Hard stop still active at {formatMark(position.stop_loss)}.
                  </p>
                ) : plan.uptrend_intact ? (
                  <p className="ags-exitplan__note ags-exitplan__note--hold">
                    Uptrend intact — holding for higher profit. Will secure only if the {windowLabel(plan)}{' '}
                    trend breaks and price falls to lock {formatMark(plan.profit_lock)}.
                  </p>
                ) : (
                  <p className="ags-exitplan__note ags-exitplan__note--warn">
                    Uptrend broken — securing at lock {formatMark(plan.profit_lock)} if price stays below peak.
                    {plan.should_secure ? ' Close trigger active.' : ''}
                  </p>
                )}

                {plan?.updated_at ? (
                  <footer className="ags-exitplan__foot">
                    Updated {formatDbTimestamp(plan.updated_at)}
                    {plan.active
                      ? plan.uptrend_intact
                        ? ' · holding (uptrend)'
                        : ' · trail armed'
                      : ' · idle'}
                    {plan.sample_count != null ? ` · ${plan.sample_count} ws tick(s) in ${windowLabel(plan)}` : ''}
                    {plan.price_source ? ` · ${plan.price_source}` : ''}
                  </footer>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}
