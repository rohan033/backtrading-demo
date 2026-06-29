import type { EarningsMonitorAlert, WatchlistEarningsRef } from '../../lib/marketResearch'
import './EarningsMonitorBar.css'

type EarningsMonitorBarProps = {
  alerts: EarningsMonitorAlert[]
  onDismiss: (id: string) => void
  onOpenSymbol: (ref: WatchlistEarningsRef) => void
  onOpenEarnings: () => void
}

export default function EarningsMonitorBar({
  alerts,
  onDismiss,
  onOpenSymbol,
  onOpenEarnings,
}: EarningsMonitorBarProps) {
  if (!alerts.length) return null

  return (
    <div className="er-monitor-bar" role="region" aria-label="Earnings monitor alerts">
      {alerts.map(alert => {
        const ref = alert.watchlistRefs?.[0]
        return (
          <div
            key={alert.id}
            className={`er-monitor-bar__item er-monitor-bar__item--${alert.phase}`}
          >
            <div className="er-monitor-bar__copy">
              <strong>{alert.symbol}</strong>
              <span>{alert.message}</span>
            </div>
            <div className="er-monitor-bar__actions">
              {ref?.symboltoken ? (
                <button
                  type="button"
                  className="er-monitor-bar__btn"
                  onClick={() => onOpenSymbol(ref)}
                >
                  Watch
                </button>
              ) : null}
              <button
                type="button"
                className="er-monitor-bar__btn er-monitor-bar__btn--ghost"
                onClick={onOpenEarnings}
              >
                Calendar
              </button>
              <button
                type="button"
                className="er-monitor-bar__dismiss"
                aria-label={`Dismiss ${alert.symbol} earnings alert`}
                onClick={() => onDismiss(alert.id)}
              >
                ×
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
