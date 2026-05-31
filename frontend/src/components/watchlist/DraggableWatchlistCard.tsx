import { useCallback, useRef, type ReactNode } from 'react'

import type { WatchlistCardLayout } from '../../lib/watchlistLayout'
import {
  CARD_CHROME_PX,
  CARD_HEADER_PX,
  clampBodyHeight,
  clampWidth,
} from '../../lib/watchlistLayout'

type ResizeMode = 'move' | 'resize-e' | 'resize-s' | 'resize-se'

type Props = {
  layout: WatchlistCardLayout
  onLayoutChange: (next: WatchlistCardLayout) => void
  children: ReactNode
}

export default function DraggableWatchlistCard({ layout, onLayoutChange, children }: Props) {
  const dragRef = useRef<{
    mode: ResizeMode
    startX: number
    startY: number
    origin: WatchlistCardLayout
  } | null>(null)

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const dx = event.clientX - drag.startX
      const dy = event.clientY - drag.startY

      if (drag.mode === 'move') {
        onLayoutChange({
          ...drag.origin,
          x: Math.max(0, drag.origin.x + dx),
          y: Math.max(0, drag.origin.y + dy),
        })
        return
      }

      const next = { ...drag.origin }
      if (drag.mode === 'resize-e' || drag.mode === 'resize-se') {
        next.width = clampWidth(drag.origin.width + dx)
      }
      if (drag.mode === 'resize-s' || drag.mode === 'resize-se') {
        next.bodyHeight = clampBodyHeight(drag.origin.bodyHeight + dy)
      }
      onLayoutChange(next)
    },
    [onLayoutChange],
  )

  const endDrag = useCallback(() => {
    dragRef.current = null
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', endDrag)
  }, [onPointerMove])

  const startDrag = (mode: ResizeMode) => (event: React.PointerEvent) => {
    if (mode === 'move' && (event.target as HTMLElement).closest('[data-no-drag]')) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    dragRef.current = { mode, startX: event.clientX, startY: event.clientY, origin: layout }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', endDrag)
  }

  const cardHeight = CARD_HEADER_PX + layout.bodyHeight + CARD_CHROME_PX

  return (
    <div
      className="absolute z-10 flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-md"
      style={{
        left: layout.x,
        top: layout.y,
        width: layout.width,
        height: cardHeight,
        minHeight: cardHeight,
      }}
      onPointerDown={event => {
        const el = event.target as HTMLElement
        if (el.closest('[data-no-drag]')) return
        if (el.closest('[data-resize-handle]')) return
        if (el.closest('[data-watchlist-drag]')) {
          startDrag('move')(event)
        }
      }}
    >
      <div className="min-h-0 flex-1 flex flex-col">{children}</div>

      {/* Right edge — horizontal resize */}
      <button
        type="button"
        aria-label="Resize width"
        data-resize-handle
        className="absolute bottom-6 right-0 top-8 z-20 w-1.5 cursor-ew-resize hover:bg-accent/30"
        onPointerDown={startDrag('resize-e')}
      />
      {/* Bottom edge — vertical resize */}
      <button
        type="button"
        aria-label="Resize height"
        data-resize-handle
        className="absolute bottom-0 left-2 right-2 z-20 h-1.5 cursor-ns-resize hover:bg-accent/30"
        onPointerDown={startDrag('resize-s')}
      />
      {/* Corner — width + height */}
      <button
        type="button"
        aria-label="Resize width and height"
        data-resize-handle
        className="absolute bottom-0 right-0 z-30 h-3 w-3 cursor-nwse-resize rounded-tl bg-border/90 hover:bg-accent/40"
        onPointerDown={startDrag('resize-se')}
      />
    </div>
  )
}
