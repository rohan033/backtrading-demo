import type { AgenticSessionPosition } from '@/lib/agenticSessions'
import type { AgenticPositionLiveQuote } from '@/hooks/useAgenticPositionLiveFeed'
import { formatBrokerMoney } from '@/lib/currency'
import { Empty, Panel, agentGlyph, money, pnlClass } from './shared'

function formatMark(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const digits = value < 1 ? 4 : value < 10 ? 3 : 2
  return formatBrokerMoney('etoro', value, digits)
}

export default function PositionsPanel({
  positions,
  closingId,
  onClose,
  interactive,
  liveByTicker,
}: {
  positions: AgenticSessionPosition[]
  closingId: string
  onClose: (position: AgenticSessionPosition) => void
  interactive: boolean
  liveByTicker: Record<string, AgenticPositionLiveQuote>
}) {
  return (
    <Panel title="Positions" count={positions.length} bodyClassName="ags-poslist__body">
      {positions.length === 0 ? (
        <Empty>No open positions yet.</Empty>
      ) : (
        <ul className="ags-poslist" aria-label="Open positions">
          {positions.map(position => {
            const ticker = position.ticker.toUpperCase()
            const live = liveByTicker[ticker]
            const mark = live?.mark ?? position.current_price
            const pnl = live?.unrealizedPnl ?? position.unrealized_pnl
            const flashClass = live?.flash ? ` ags-pos-pill--flash-${live.flash}` : ''
            const plan = position.exit_plan
            const nextTp = plan?.next_level
            const profitLock = plan?.profit_lock

            return (
              <li key={position.id} className="ags-pos-row">
                <span className="ags-pos-row__icon" aria-hidden>{agentGlyph('session')}</span>
                <span className="ags-pos-row__ticker">{position.ticker}</span>
                {position.exit_state !== 'running' ? (
                  <span
                    className={`ags-exit-badge ags-exit-badge--${position.exit_state}`}
                    title={`Exit state: ${position.exit_state}`}
                  >
                    {position.exit_state}
                  </span>
                ) : null}

                <span
                  className={`ags-pos-pill ags-pos-pill--live${flashClass}`}
                  title={live?.live ? 'Live eToro watchlist price' : 'Snapshot price (waiting for live feed)'}
                >
                  {live?.live ? <span className="ags-pos-pill__tag">Live</span> : null}
                  <span className="ags-pos-pill__value">{formatMark(mark)}</span>
                </span>

                <span className="ags-pos-pill ags-pos-pill--entry" title="Entry price">
                  <span className="ags-pos-pill__tag">Entry</span>
                  <span className="ags-pos-pill__value">@{formatMark(position.buy_price)}</span>
                </span>

                <span className="ags-pos-pill ags-pos-pill--sl" title="Hard stop loss">
                  <span className="ags-pos-pill__tag">SL</span>
                  <span className="ags-pos-pill__value">{formatMark(position.stop_loss)}</span>
                </span>

                {profitLock != null && profitLock > position.buy_price ? (
                  <span className="ags-pos-pill ags-pos-pill--lock" title="Ratcheting profit lock (portfolio monitor)">
                    <span className="ags-pos-pill__tag">Lock</span>
                    <span className="ags-pos-pill__value">{formatMark(profitLock)}</span>
                  </span>
                ) : null}

                {nextTp && !nextTp.hit ? (
                  <span className="ags-pos-pill ags-pos-pill--tp" title={nextTp.label}>
                    <span className="ags-pos-pill__tag">TP</span>
                    <span className="ags-pos-pill__value">{formatMark(nextTp.price)}</span>
                  </span>
                ) : null}

                <span className={`ags-pos-row__pnl ${pnlClass(pnl)}`} title="Unrealized P/L">
                  {money(pnl, true)}
                </span>

                <button
                  type="button"
                  className="ags-close-btn ags-close-btn--tiny"
                  disabled={!interactive || closingId === position.id}
                  onClick={() => onClose(position)}
                  aria-label={`Close ${position.ticker}`}
                  title="Close at market (sent at most once)"
                >
                  {closingId === position.id ? '…' : '×'}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}
