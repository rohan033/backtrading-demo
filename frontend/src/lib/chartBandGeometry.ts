import type { IChartApi, Time } from 'lightweight-charts'

export type ChartBandRect = {
  left: number
  width: number
}

export type ChartTimeEdges = {
  from: number
  to: number
  width: number
}

export function chartTimeEdges(chart: IChartApi): ChartTimeEdges | null {
  const width = chart.timeScale().width()
  if (width <= 0) return null

  const leftRaw = chart.timeScale().coordinateToTime(0)
  const rightRaw = chart.timeScale().coordinateToTime(width)
  if (leftRaw != null && rightRaw != null) {
    const from = typeof leftRaw === 'number' ? leftRaw : Number(leftRaw)
    const to = typeof rightRaw === 'number' ? rightRaw : Number(rightRaw)
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
      return { from, to, width }
    }
  }

  const visible = chart.timeScale().getVisibleRange()
  if (!visible) return null

  const from = typeof visible.from === 'number' ? visible.from : Number(visible.from)
  const to = typeof visible.to === 'number' ? visible.to : Number(visible.to)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null

  return { from, to, width }
}

export function timeToPlotX(
  chart: IChartApi,
  edges: ChartTimeEdges,
  time: number,
): number | null {
  if (time <= edges.from) return 0
  if (time >= edges.to) return edges.width

  const direct = chart.timeScale().timeToCoordinate(time as Time)
  if (direct != null) return direct

  return ((time - edges.from) / (edges.to - edges.from)) * edges.width
}

export function chartBandRect(
  chart: IChartApi,
  fromTime: number,
  toTime: number,
): ChartBandRect | null {
  const edges = chartTimeEdges(chart)
  if (!edges) return null

  const start = Math.min(fromTime, toTime)
  const end = Math.max(fromTime, toTime)
  const clippedStart = Math.max(start, edges.from)
  const clippedEnd = Math.min(end, edges.to)
  if (clippedEnd <= clippedStart) return null

  const left = timeToPlotX(chart, edges, clippedStart)
  const right = timeToPlotX(chart, edges, clippedEnd)
  if (left == null || right == null) return null

  const width = right - left
  if (width < 1) return null
  return { left, width }
}
