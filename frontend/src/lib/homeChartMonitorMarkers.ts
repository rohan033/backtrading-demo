import type { Time } from 'lightweight-charts'

import type { ClientMonitorMarker } from './agentClientMonitorCache'

export type HomeChartMonitorMarker = {
  time: Time
  position: 'belowBar'
  color: string
  shape: 'circle'
  text: string
  id: string
}

const MARKER_COLOR = '#7B61FF'

function minuteBucket(unixSeconds: number): number {
  return Math.floor(unixSeconds / 60) * 60
}

export function buildHomeChartMonitorMarkers(
  markers: ClientMonitorMarker[],
): HomeChartMonitorMarker[] {
  return markers.map(marker => ({
    time: minuteBucket(marker.time) as Time,
    position: 'belowBar' as const,
    color: MARKER_COLOR,
    shape: 'circle' as const,
    text: marker.eventCount > 1 ? String(marker.eventCount) : 'M',
    id: marker.id,
  }))
}
