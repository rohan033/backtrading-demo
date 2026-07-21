import { useEffect, useMemo, useState } from 'react'

import type { TradeHalt, TradeHaltNotification } from '../../lib/tradeHalts'
import './TradeHaltNotificationsBar.css'

const CHIP_DISMISS_KEY = 'trade-halts-chip-dismissed'

type Props = {
  notifications: TradeHaltNotification[]
  todayHalts?: TradeHalt[]
  day?: string | null
  onDismiss: (id: string) => void
  onDismissAll?: () => void
}

function chipSignature(halts: TradeHalt[]): string {
  return halts
    .filter(item => item.status === 'halted')
    .map(item => item.symbol)
    .sort()
    .join('|')
}

function readDismissedSignature(): string {
  try {
    return sessionStorage.getItem(CHIP_DISMISS_KEY) || ''
  } catch {
    return ''
  }
}

function writeDismissedSignature(signature: string) {
  try {
    if (!signature) sessionStorage.removeItem(CHIP_DISMISS_KEY)
    else sessionStorage.setItem(CHIP_DISMISS_KEY, signature)
  } catch {
    // ignore storage failures
  }
}

export default function TradeHaltNotificationsBar({
  notifications,
  todayHalts = [],
  day,
  onDismiss,
  onDismissAll,
}: Props) {
  const activeHalted = useMemo(
    () => todayHalts.filter(item => item.status === 'halted'),
    [todayHalts],
  )
  const signature = useMemo(() => chipSignature(activeHalted), [activeHalted])
  const [chipHidden, setChipHidden] = useState(() => {
    const stored = readDismissedSignature()
    return Boolean(stored && stored === chipSignature(todayHalts))
  })

  useEffect(() => {
    const stored = readDismissedSignature()
    // Re-show when the active halted set changes after a prior dismiss.
    setChipHidden(Boolean(stored && stored === signature && signature))
  }, [signature])

  if (!notifications.length && (!activeHalted.length || chipHidden)) return null

  const showChip = activeHalted.length > 0 && !chipHidden

  const dismissChip = () => {
    writeDismissedSignature(signature)
    setChipHidden(true)
  }

  return (
    <div className="th-toast-stack" role="region" aria-label="Trade halt notifications">
      {showChip ? (
        <div className="th-day-chip" title={day ? `Halts for ${day}` : "Today's trade halts"}>
          <span className="th-day-chip__label">Halts today</span>
          <strong className="th-day-chip__count">{activeHalted.length}</strong>
          <span className="th-day-chip__symbols">
            {activeHalted
              .slice(0, 6)
              .map(item => item.symbol)
              .join(' · ')}
            {activeHalted.length > 6 ? ` · +${activeHalted.length - 6}` : ''}
          </span>
          <button
            type="button"
            className="th-day-chip__dismiss"
            aria-label="Dismiss halts today summary"
            onClick={dismissChip}
          >
            ×
          </button>
        </div>
      ) : null}
      {notifications.length > 1 && onDismissAll ? (
        <button type="button" className="th-toast-stack__clear" onClick={onDismissAll}>
          Clear all ({notifications.length})
        </button>
      ) : null}
      {notifications.map(alert => {
        const eventType = alert.event_type === 'resumed' ? 'resumed' : 'halted'
        const reason = alert.payload?.reason_code
        return (
          <div
            key={alert.id}
            className={`th-toast th-toast--${eventType}`}
            title={alert.headline}
          >
            <span className="th-toast__dot" aria-hidden="true" />
            <div className="th-toast__copy">
              <span className="th-toast__label">
                {eventType === 'resumed' ? 'Trading resumed' : 'Trading halted'}
                {reason ? ` · ${reason}` : ''}
              </span>
              <strong className="th-toast__ticker">{alert.symbol}</strong>
              <span className="th-toast__detail">{alert.headline}</span>
            </div>
            <button
              type="button"
              className="th-toast__dismiss"
              aria-label={`Dismiss ${alert.symbol} halt notification`}
              onClick={() => onDismiss(alert.id)}
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}
