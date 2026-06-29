import type { Time } from 'lightweight-charts'

import type { CompanyNewsItem } from './companyNews'

export type HomeChartNewsMarker = {
  time: Time
  position: 'aboveBar'
  color: string
  shape: 'square'
  text: string
  id: string
}

export type HomeChartNewsMarkerMeta = {
  time: number
  items: CompanyNewsItem[]
}

const MARKER_COLOR = '#D4A017'
const MAX_MARKERS = 12

function minuteBucket(unixSeconds: number): number {
  return Math.floor(unixSeconds / 60) * 60
}

function evenlySample<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items
  if (limit <= 1) return [items[items.length - 1]]

  const step = (items.length - 1) / (limit - 1)
  const picked: T[] = []
  for (let i = 0; i < limit; i += 1) {
    picked.push(items[Math.round(i * step)])
  }
  return picked
}

export function groupCompanyNewsByMinute(
  items: CompanyNewsItem[],
  range?: { from: number; to: number } | null,
): HomeChartNewsMarkerMeta[] {
  const buckets = new Map<number, CompanyNewsItem[]>()

  for (const item of items) {
    if (!item.datetime) continue
    const time = minuteBucket(item.datetime)
    if (range && (time < range.from || time > range.to)) continue
    const bucket = buckets.get(time) ?? []
    bucket.push(item)
    buckets.set(time, bucket)
  }

  return [...buckets.entries()]
    .map(([time, bucketItems]) => ({
      time,
      items: [...bucketItems].sort((a, b) => (b.datetime || 0) - (a.datetime || 0)),
    }))
    .sort((a, b) => a.time - b.time)
}

export function buildHomeChartNewsMarkers(
  items: CompanyNewsItem[],
  range?: { from: number; to: number } | null,
  maxMarkers = MAX_MARKERS,
): { markers: HomeChartNewsMarker[]; byTime: Map<number, CompanyNewsItem[]> } {
  const grouped = groupCompanyNewsByMinute(items, range)
  const sampled = evenlySample(grouped, maxMarkers)
  const byTime = new Map<number, CompanyNewsItem[]>()

  const markers = sampled.map(group => {
    byTime.set(group.time, group.items)
    return {
      time: group.time as Time,
      position: 'aboveBar' as const,
      color: MARKER_COLOR,
      shape: 'square' as const,
      text: group.items.length > 1 ? String(group.items.length) : '',
      id: `news-${group.time}`,
    }
  })

  return { markers, byTime }
}

export function newsItemsAtChartTime(
  byTime: Map<number, CompanyNewsItem[]>,
  time: number,
): CompanyNewsItem[] {
  return byTime.get(minuteBucket(time)) ?? []
}

export function candleChartTimeRange(
  candles: Array<{ time: number }>,
): { from: number; to: number } | null {
  if (!candles.length) return null
  return {
    from: candles[0].time,
    to: candles[candles.length - 1].time,
  }
}
