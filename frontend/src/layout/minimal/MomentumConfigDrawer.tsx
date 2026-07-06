import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import WatchAndTradeMomentumSettings from '../../components/watchlist/WatchAndTradeMomentumSettings'
import type { MomentumConfig } from '../../lib/watchlistMomentum'
import { safeSetItem } from '../../lib/safeStorage'
import './MomentumConfigDrawer.css'

const WIDTH_KEY = 'minimal-momentum-drawer-width-v2'
const MIN_WIDTH = 560
const MAX_WIDTH = 1100
const DEFAULT_WIDTH = 820

type MonitoredSymbol = {
  symbol: string
  tradeEnv: 'live' | 'demo'
  noTakeProfit: boolean
}

function loadWidth(): number {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY))
    if (Number.isFinite(value)) {
      return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value))
    }
  } catch {
    // ignore
  }
  return DEFAULT_WIDTH
}

type Props = {
  open: boolean
  onClose: () => void
  config: MomentumConfig
  onChange: (config: MomentumConfig) => void
  monitoredSymbols: MonitoredSymbol[]
}

export default function MomentumConfigDrawer({
  open,
  onClose,
  config,
  onChange,
  monitoredSymbols,
}: Props) {
  const [width, setWidth] = useState(loadWidth)
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const startResize = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    resizeRef.current = { startX: event.clientX, startWidth: width }
    document.body.classList.add('ms-resizing')

    const onMove = (moveEvent: MouseEvent) => {
      const active = resizeRef.current
      if (!active) return
      const next = Math.min(
        MAX_WIDTH,
        Math.max(MIN_WIDTH, active.startWidth + active.startX - moveEvent.clientX),
      )
      setWidth(next)
      safeSetItem(WIDTH_KEY, String(next))
    }

    const onUp = () => {
      resizeRef.current = null
      document.body.classList.remove('ms-resizing')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <>
      <button
        type="button"
        className="wmom-backdrop"
        aria-label="Close momentum settings"
        onClick={onClose}
      />
      <aside
        className="wmom-drawer"
        role="dialog"
        aria-label="Momentum settings"
        style={{ width, minWidth: width }}
      >
        <div
          className="wmom-drawer-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize drawer"
          onMouseDown={startResize}
        />
        <div className="wmom-head">
          <div>
            <strong>Momentum config</strong>
            <span>Auto-scan &amp; deploy rules</span>
          </div>
          <button type="button" className="wmom-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="wmom-body">
          <WatchAndTradeMomentumSettings
            config={config}
            onChange={onChange}
            monitoredSymbols={monitoredSymbols}
          />
        </div>
      </aside>
    </>,
    document.body,
  )
}
