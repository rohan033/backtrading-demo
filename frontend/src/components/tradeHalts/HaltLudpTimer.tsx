import type { TradeHalt } from '../../lib/tradeHalts'
import { computeLudpHaltTimer } from '../../lib/tradeHaltsUi'
import { useSecondTicker } from '../../hooks/useSecondTicker'
import './HaltLudpTimer.css'

type Props = {
  halt: TradeHalt
  compact?: boolean
  pill?: boolean
}

export default function HaltLudpTimer({ halt, compact = false, pill = false }: Props) {
  const now = useSecondTicker()
  const timer = computeLudpHaltTimer(halt, now)

  if (!timer) return null

  const urgent = timer.phase === 'countdown' && timer.remainingMs <= 60_000
  const fillClass = timer.phase === 'gap'
    ? ' halt-ludp-timer__fill--gap'
    : urgent
      ? ' halt-ludp-timer__fill--urgent'
      : ''

  return (
    <div
      className={`halt-ludp-timer${
        pill ? ' halt-ludp-timer--pill' : compact ? ' halt-ludp-timer--compact' : ''
      }`}
      title={
        timer.phase === 'countdown'
          ? `${timer.label} left in LUDP window ${timer.cycle}`
          : `Waiting ${timer.label.toLowerCase()} before next 5-minute window`
      }
    >
      <div className="halt-ludp-timer__meta">
        <span className="halt-ludp-timer__label">{timer.label}</span>
        <span className="halt-ludp-timer__cycle">#{timer.cycle}</span>
      </div>
      <div
        className="halt-ludp-timer__track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(timer.progressPct)}
        aria-label={
          timer.phase === 'countdown'
            ? `LUDP resume window ${timer.cycle}, ${timer.label} remaining`
            : `Gap before LUDP window ${timer.cycle + 1}`
        }
      >
        <div
          className={`halt-ludp-timer__fill${fillClass}`}
          style={{ width: `${Math.max(0, Math.min(100, timer.progressPct))}%` }}
        />
      </div>
      <div className="halt-ludp-timer__hint">
        {timer.phase === 'countdown' ? '5m resume window' : 'Restarting window'}
      </div>
    </div>
  )
}