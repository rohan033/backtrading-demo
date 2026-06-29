import { useCallback, useEffect, useRef, useState } from 'react'
import type { IChartApi, Time } from 'lightweight-charts'

export type ChartTimeRange = {
  fromTime: number
  toTime: number
}

type DragState = {
  startX: number
  currentX: number
}

type MenuState = {
  x: number
  y: number
}

function normalizeRange(fromTime: number, toTime: number): ChartTimeRange {
  return {
    fromTime: Math.min(fromTime, toTime),
    toTime: Math.max(fromTime, toTime),
  }
}

function timeFromChart(chart: IChartApi, x: number): number | null {
  const raw = chart.timeScale().coordinateToTime(x)
  if (raw == null) return null
  const time = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(time) ? time : null
}

function bandStyle(
  chart: IChartApi,
  range: ChartTimeRange,
  height: number,
): { left: number; width: number } | null {
  const leftCoord = chart.timeScale().timeToCoordinate(range.fromTime as Time)
  const rightCoord = chart.timeScale().timeToCoordinate(range.toTime as Time)
  if (leftCoord == null || rightCoord == null) return null

  const left = Math.min(leftCoord, rightCoord)
  const width = Math.abs(rightCoord - leftCoord)
  if (width < 2) return null

  return { left, width }
}

type Props = {
  chartRef: React.RefObject<IChartApi | null>
  enabled?: boolean
  activeRange?: ChartTimeRange | null
  onRangeChange?: (range: ChartTimeRange | null) => void
  onAddToChat?: (range: ChartTimeRange) => void
}

export default function HomeChartRangeSelector({
  chartRef,
  enabled = true,
  activeRange = null,
  onRangeChange,
  onAddToChat,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [localRange, setLocalRange] = useState<ChartTimeRange | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [band, setBand] = useState<{ left: number; width: number } | null>(null)
  const [shiftHeld, setShiftHeld] = useState(false)

  const committedRange = activeRange ?? localRange
  const selecting = Boolean(drag) || shiftHeld

  const updateBand = useCallback(() => {
    const chart = chartRef.current
    const wrap = wrapRef.current
    if (!chart || !wrap || !committedRange) {
      setBand(null)
      return
    }
    setBand(bandStyle(chart, committedRange, wrap.clientHeight))
  }, [chartRef, committedRange])

  useEffect(() => {
    updateBand()
  }, [updateBand])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !committedRange) return undefined

    const handleVisibleRange = () => updateBand()
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRange)
    const observer = new ResizeObserver(handleVisibleRange)
    if (wrapRef.current) observer.observe(wrapRef.current)

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRange)
      observer.disconnect()
    }
  }, [chartRef, committedRange, updateBand])

  useEffect(() => {
    if (!enabled) {
      setDrag(null)
      setLocalRange(null)
      setMenu(null)
      onRangeChange?.(null)
    }
  }, [enabled, onRangeChange])

  useEffect(() => {
    const closeMenu = () => setMenu(null)
    window.addEventListener('click', closeMenu)
    window.addEventListener('scroll', closeMenu, true)
    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('scroll', closeMenu, true)
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Shift') setShiftHeld(true)
    }
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift') setShiftHeld(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [])

  const commitDrag = useCallback((state: DragState) => {
    const chart = chartRef.current
    const wrap = wrapRef.current
    if (!chart || !wrap) return

    const rect = wrap.getBoundingClientRect()
    const startX = Math.max(0, Math.min(rect.width, state.startX))
    const endX = Math.max(0, Math.min(rect.width, state.currentX))
    const fromTime = timeFromChart(chart, startX)
    const toTime = timeFromChart(chart, endX)
    if (fromTime == null || toTime == null) return

    const range = normalizeRange(fromTime, toTime)
    if (range.toTime - range.fromTime < 60) return

    setLocalRange(range)
    onRangeChange?.(range)
  }, [chartRef, onRangeChange])

  useEffect(() => {
    if (!drag) return undefined

    const handleMove = (event: PointerEvent) => {
      const wrap = wrapRef.current
      if (!wrap) return
      const rect = wrap.getBoundingClientRect()
      setDrag(prev => prev ? {
        ...prev,
        currentX: event.clientX - rect.left,
      } : prev)
    }

    const handleUp = () => {
      setDrag(current => {
        if (current) commitDrag(current)
        return null
      })
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
  }, [commitDrag, drag])

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!enabled || !event.shiftKey || event.button !== 0) return
    const wrap = wrapRef.current
    if (!wrap) return

    event.preventDefault()
    event.stopPropagation()
    setMenu(null)

    const rect = wrap.getBoundingClientRect()
    const startX = event.clientX - rect.left
    setDrag({ startX, currentX: startX })
  }

  const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!committedRange || !band) return
    const wrap = wrapRef.current
    if (!wrap) return

    const rect = wrap.getBoundingClientRect()
    const x = event.clientX - rect.left
    if (x < band.left || x > band.left + band.width) return

    event.preventDefault()
    setMenu({ x: event.clientX - rect.left, y: event.clientY - rect.top })
  }

  const dragBand = (() => {
    if (!drag || !wrapRef.current) return null
    const left = Math.min(drag.startX, drag.currentX)
    const width = Math.abs(drag.currentX - drag.startX)
    return width >= 2 ? { left, width } : null
  })()

  const visibleBand = dragBand ?? band

  return (
    <div
      ref={wrapRef}
      className={`hm-chart-range-layer${selecting ? ' hm-chart-range-layer--selecting' : ''}`}
      onPointerDown={handlePointerDown}
      onContextMenu={handleContextMenu}
    >
      {visibleBand ? (
        <div
          className={`hm-chart-range-band${drag ? ' hm-chart-range-band--dragging' : ''}`}
          style={{
            left: `${visibleBand.left}px`,
            width: `${visibleBand.width}px`,
          }}
        />
      ) : null}
      {menu && committedRange ? (
        <div
          className="hm-chart-range-menu"
          style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
          onClick={event => event.stopPropagation()}
        >
          <button
            type="button"
            className="hm-chart-range-menu-item"
            onClick={() => {
              onAddToChat?.(committedRange)
              setMenu(null)
            }}
          >
            Add to AI chat
          </button>
        </div>
      ) : null}
    </div>
  )
}
