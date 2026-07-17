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
    <div className="er-toast-stack" role="region" aria-label="Earnings notifications">
      {alerts.map(alert => {
        const ref = alert.watchlistRefs?.[0]
        const handleShow = () => {
          if (ref?.symboltoken) onOpenSymbol(ref)
          else onOpenEarnings()
        }
        return (
          <div
            key={alert.id}
            className={`er-toast er-toast--${alert.phase}`}
            title={alert.message}
          >
            <span className="er-toast__dot" aria-hidden="true" />
            <div className="er-toast__copy">
              <span className="er-toast__label">Earnings notification</span>
              <strong className="er-toast__ticker">{alert.symbol}</strong>
            </div>
            <button
              type="button"
              className="er-toast__show"
              onClick={handleShow}
            >
              Show
            </button>
            <button
              type="button"
              className="er-toast__dismiss"
              aria-label={`Dismiss ${alert.symbol} earnings alert`}
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
