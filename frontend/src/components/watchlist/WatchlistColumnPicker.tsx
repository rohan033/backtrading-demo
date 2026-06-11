import { Columns3 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import {
  WATCHLIST_CHANGE_WINDOWS,
  type WatchlistChangeWindowId,
} from '../../lib/watchlistChangeColumns'

type Props = {
  visibleColumns: WatchlistChangeWindowId[]
  onChange: (next: WatchlistChangeWindowId[]) => void
}

export default function WatchlistColumnPicker({ visibleColumns, onChange }: Props) {
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
    <div ref={rootRef} className="relative" data-no-drag>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-[11px] font-medium text-text-secondary hover:border-accent/40 hover:text-text-primary"
        title="Show or hide change columns"
      >
        <Columns3 className="h-3.5 w-3.5" />
        Columns
        {visibleColumns.length > 0 ? (
          <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
            {visibleColumns.length}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 z-30 mt-2 w-44 rounded-lg border border-border bg-card p-2 shadow-lg shadow-black/30">
          <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
            % change windows
          </p>
          <p className="px-2 pb-2 text-[10px] leading-snug text-text-secondary/80">
            Tracked locally from live ticks while this page is open.
          </p>
          <div className="space-y-0.5">
            {WATCHLIST_CHANGE_WINDOWS.map(window => {
              const checked = visibleColumns.includes(window.id)
              return (
                <label
                  key={window.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent/5"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(window.id)}
                    className="rounded border-border"
                  />
                  <span className="font-medium text-text-primary">{window.label}</span>
                </label>
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
}
