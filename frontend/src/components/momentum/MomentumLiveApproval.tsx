import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import type { MomentumSignal } from '../../lib/watchlistMomentum'
import './MomentumLiveApproval.css'

export type LiveApprovalRequest = {
  id: string
  tradingsymbol: string
  tradeEnv: 'live'
  noTakeProfit: boolean
  signal: MomentumSignal
  currentPrice: number
  onApprove: () => void
  onCancel: () => void
}

const APPROVAL_SECONDS = 5

export default function MomentumLiveApproval({ request }: { request: LiveApprovalRequest }) {
  const [secondsLeft, setSecondsLeft] = useState(APPROVAL_SECONDS)

  useEffect(() => {
    setSecondsLeft(APPROVAL_SECONDS)
    const id = window.setInterval(() => {
      setSecondsLeft(prev => {
        if (prev <= 1) {
          window.clearInterval(id)
          request.onCancel()
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.id])

  if (typeof document === 'undefined') return null

  const bracket = request.noTakeProfit ? 'No TP · 1% SL' : '5% TP · 1% SL'

  return createPortal(
    <div
      className="mom-approval-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mom-approval-title"
      onClick={request.onCancel}
    >
      <div className="mom-approval" onClick={e => e.stopPropagation()}>
        <div className="mom-approval__head">
          <strong id="mom-approval-title">Approve live momentum trade?</strong>
          <span>
            Auto-cancels in <em>{secondsLeft}s</em>
          </span>
        </div>
        <div className="mom-approval__body">
          <div className="mom-approval__row">
            <span>Symbol</span>
            <strong>{request.tradingsymbol}</strong>
          </div>
          <div className="mom-approval__row">
            <span>Environment</span>
            <span className="mom-approval__env mom-approval__env--live">LIVE</span>
          </div>
          <div className="mom-approval__row">
            <span>Price</span>
            <strong>{request.currentPrice.toFixed(2)}</strong>
          </div>
          <div className="mom-approval__row">
            <span>Bracket</span>
            <strong>{bracket}</strong>
          </div>
          <p className="mom-approval__signal">{request.signal.headline}</p>
        </div>
        <div className="mom-approval__actions">
          <button type="button" className="mom-approval__cancel" onClick={request.onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="mom-approval__approve"
            autoFocus
            onClick={request.onApprove}
          >
            Approve ({secondsLeft}s)
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
