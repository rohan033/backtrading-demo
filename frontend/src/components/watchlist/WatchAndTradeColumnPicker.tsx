import { useEffect, useRef, useState } from 'react'

import {
  WATCHLIST_CHANGE_WINDOWS,
  type WatchlistChangeWindowId,
} from '../../lib/watchlistChangeColumns'

type Props = {
  visibleColumns: WatchlistChangeWindowId[]
  onChange: (next: WatchlistChangeWindowId[]) => void
}

export default function WatchAndTradeColumnPicker({ visibleColumns, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const toggle = (id: WatchlistChangeWindowId) => {
    if (visibleColumns.includes(id)) {
      onChange(visibleColumns.filter(column => column !== id))
      return
    }
    const order = WATCHLIST_CHANGE_WINDOWS.map(window => window.id)
    onChange([...visibleColumns, id].sort((a, b) => order.indexOf(a) - order.indexOf(b)))
  }

  return (
    <div ref={rootRef} className="wt-toolbar-pop">
      <button
        type="button"
        className={`wt-toolbar-btn${open ? ' wt-toolbar-btn--open' : ''}`}
        onClick={() => setOpen(v => !v)}
        title="Show or hide change columns"
        aria-expanded={open}
      >
        Columns
        {visibleColumns.length > 0 ? (
          <span className="wt-toolbar-badge">{visibleColumns.length}</span>
        ) : null}
      </button>

      {open ? (
        <div className="wt-toolbar-menu wt-toolbar-menu--right">
          <div className="wt-toolbar-menu__title">% change windows</div>
          <p className="wt-toolbar-menu__hint">Tracked from live ticks while this page is open.</p>
          {WATCHLIST_CHANGE_WINDOWS.map(window => (
            <label key={window.id} className="wt-toolbar-menu__row">
              <input
                type="checkbox"
                checked={visibleColumns.includes(window.id)}
                onChange={() => toggle(window.id)}
              />
              <span>{window.label}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  )
}
