import { useCallback, useRef, type ReactNode } from 'react'

import type { WatchlistCardLayout } from '../../lib/watchlistLayout'
import { cardHeightForContent, clampWidth } from '../../lib/watchlistLayout'

type Props = {
  layout: WatchlistCardLayout
  symbolCount: number
  searchOpen: boolean
  onLayoutChange: (next: WatchlistCardLayout) => void
  children: ReactNode
}

export default function DraggableWatchlistCard({
  layout,
  symbolCount,
  searchOpen,
  onLayoutChange,
  children,
}: Props) {
  const dragRef = useRef<{
    mode: 'move' | 'resize-e'
    startX: number
    startY: number
    origin: WatchlistCardLayout
  } | null>(null)

  const cardHeight = cardHeightForContent(symbolCount, searchOpen)

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

      onLayoutChange({
        ...drag.origin,
        width: clampWidth(drag.origin.width + dx),
      })
    },
    [onLayoutChange],
  )

  const endDrag = useCallback(() => {
    dragRef.current = null
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', endDrag)
  }, [onPointerMove])

  const startDrag = (mode: 'move' | 'resize-e') => (event: React.PointerEvent) => {
    if (mode === 'move' && (event.target as HTMLElement).closest('[data-no-drag]')) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    dragRef.current = { mode, startX: event.clientX, startY: event.clientY, origin: layout }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', endDrag)
  }

  return (
    <div
      className="absolute z-10 flex flex-col rounded-lg border border-border bg-card shadow-lg shadow-black/20 transition-[height] duration-150 ease-out"
      style={{
        left: layout.x,
        top: layout.y,
        width: layout.width,
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
      {children}
      <button
        type="button"
        aria-label="Resize width"
        data-resize-handle
        className="absolute bottom-3 right-0 top-10 z-20 w-1.5 cursor-ew-resize rounded-full hover:bg-accent/40"
        onPointerDown={startDrag('resize-e')}
      />
    </div>
  )
}
