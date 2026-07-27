import { useState } from 'react'
import type { AgenticExitPlanLevel, AgenticSessionPosition } from '@/lib/agenticSessions'
import type { AgenticPositionLiveQuote } from '@/hooks/useAgenticPositionLiveFeed'
import { formatBrokerMoney } from '@/lib/currency'
import { Empty, Panel, money, pnlClass } from './shared'

function formatMark(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const digits = value < 1 ? 4 : value < 10 ? 3 : 2
  return formatBrokerMoney('etoro', value, digits)
}

function ladderStatus(
  level: AgenticExitPlanLevel,
  nextLevelId: string | null | undefined,
): { label: string; tone: 'hit' | 'next' | 'armed' } {
  if (level.hit) {
    return { label: `hit @ ${formatMark(level.hit_price ?? level.price)}`, tone: 'hit' }
  }
  if (level.id === nextLevelId) {
    return { label: 'next — fires on pullback', tone: 'next' }
  }
  return { label: 'armed', tone: 'armed' }
}

function PositionDetail({
  position,
  mark,
}: {
  position: AgenticSessionPosition
  mark: number | null | undefined
}) {
  const plan = position.exit_plan
  const buy = Number(position.buy_price) || 0

  if (!plan) {
    return (
      <div className="ags-pos-detail">
        <p className="ags-pos-detail__note">
          Waiting for portfolio monitor — the exit plan (ladder, profit lock, stall guard)
          appears after the first ~30s websocket window.
        </p>
      </div>
    )
  }

  const uptrend = plan.uptrend_intact
  const remainingPct = Math.round((plan.remaining_fraction ?? 1) * 100)
  const levels = [...(plan.levels ?? [])].sort(
    (a, b) => (b.gain_fraction ?? 0) - (a.gain_fraction ?? 0),
  )
  const nextLevelId = plan.next_level?.id ?? null

  const holdVerdict = !plan.active
    ? {
        tone: 'idle' as const,
        title: 'Holding — secure logic idle',
        text: `Needs ≥0.35% peak gain to arm (peak ${
          plan.peak_gain_pct != null ? plan.peak_gain_pct.toFixed(2) : '0.00'
        }%). Hard stop at ${formatMark(position.stop_loss)} stays active.`,
      }
    : plan.should_secure
      ? {
          tone: 'sell' as const,
          title: 'Selling — secure trigger active',
          text: `Uptrend broke and price fell to lock ${formatMark(plan.profit_lock)} — full close on the next monitor tick.`,
        }
      : uptrend === false
        ? {
            tone: 'watch' as const,
            title: 'Watching — uptrend broken',
            text: `Full close if price falls to lock ${formatMark(plan.profit_lock)}. Ladder rungs below trim earlier on the way down.`,
          }
        : {
            tone: 'hold' as const,
            title: 'Holding — uptrend intact',
            text: `Riding for higher highs. Sells only on pullback: rungs trim as price falls to each target, full secure below lock ${formatMark(plan.profit_lock)} once the trend breaks.`,
          }

  return (
    <div className="ags-pos-detail">
      <p className={`ags-pos-detail__verdict ags-pos-detail__verdict--${holdVerdict.tone}`}>
        <strong>{holdVerdict.title}.</strong> {holdVerdict.text}
      </p>

      <div className="ags-pos-detail__grid">
        <div className="ags-pos-detail__stat">
          <span>Peak</span>
          <strong>{formatMark(plan.peak_price ?? plan.recent_high ?? null)}</strong>
        </div>
        <div className="ags-pos-detail__stat">
          <span>Peak gain</span>
          <strong>
            {plan.peak_gain_pct != null ? `${plan.peak_gain_pct.toFixed(2)}%` : '—'}
          </strong>
        </div>
        <div className="ags-pos-detail__stat">
          <span>Profit lock</span>
          <strong>
            {plan.profit_lock != null && plan.profit_lock > buy
              ? formatMark(plan.profit_lock)
              : '—'}
          </strong>
        </div>
        <div className="ags-pos-detail__stat">
          <span>Size left</span>
          <strong>{remainingPct}%</strong>
        </div>
      </div>

      {levels.length > 0 ? (
        <ul className="ags-pos-ladder" aria-label={`${position.ticker} profit ladder`}>
          {levels.map(level => {
            const status = ladderStatus(level, nextLevelId)
            const inRange =
              !level.hit && mark != null && Number.isFinite(mark) && mark <= level.price
            return (
              <li
                key={level.id}
                className={`ags-pos-ladder__rung ags-pos-ladder__rung--${status.tone}`}
              >
                <span className="ags-pos-ladder__id">{level.id}</span>
                <span className="ags-pos-ladder__target">{formatMark(level.price)}</span>
                <span className="ags-pos-ladder__label">{level.label}</span>
                <span className="ags-pos-ladder__trim">
                  trim {Math.round((level.fraction ?? 0) * 100)}%
                </span>
                <span className={`ags-pos-ladder__status${inRange ? ' ags-pos-ladder__status--near' : ''}`}>
                  {status.label}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}

      <p className="ags-pos-detail__note">
        {plan.stalled
          ? 'Stall trim taken — no new high for 90s near peak. Re-arms on a fresh high.'
          : plan.active
            ? 'Stall guard armed: trims 15% if no new high for 90s while parked near peak.'
            : 'Ladder & stall guard arm once the position is ≥0.35% above entry at peak.'}
        {plan.last_hit_price != null
          ? ` Stop ratcheted by ladder — last rung hit @ ${formatMark(plan.last_hit_price)}.`
          : ''}
      </p>
    </div>
  )
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
  const [expandedId, setExpandedId] = useState<string | null>(null)

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
            const expanded = expandedId === position.id

            return (
              <li
                key={position.id}
                className={`ags-pos-item${expanded ? ' ags-pos-item--expanded' : ''}`}
              >
                <div
                  className="ags-pos-row ags-pos-row--clickable"
                  role="button"
                  tabIndex={0}
                  aria-expanded={expanded}
                  title="Show exit ladder & strategy"
                  onClick={() => setExpandedId(expanded ? null : position.id)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setExpandedId(expanded ? null : position.id)
                    }
                  }}
                >
                  <span
                    className={`ags-pos-row__chevron${expanded ? ' ags-pos-row__chevron--open' : ''}`}
                    aria-hidden
                  >
                    ▸
                  </span>
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
                    <span className="ags-pos-pill ags-pos-pill--tp" title={`Next ladder rung — ${nextTp.label}`}>
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
                    onClick={event => {
                      event.stopPropagation()
                      onClose(position)
                    }}
                    aria-label={`Close ${position.ticker}`}
                    title={
                      position.state === 'pending_close'
                        ? 'Close in progress — click to retry sync'
                        : 'Close at market'
                    }
                  >
                    {closingId === position.id || position.state === 'pending_close' ? '…' : '×'}
                  </button>
                </div>

                {expanded ? <PositionDetail position={position} mark={mark} /> : null}
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}
