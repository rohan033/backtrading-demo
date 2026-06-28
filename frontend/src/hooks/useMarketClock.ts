import { useEffect, useState } from 'react'

import {
  formatMarketDigitalClock,
  marketClockZoneById,
  type MarketClockZoneId,
} from '../lib/marketClock'

export function useMarketClock(zoneId: MarketClockZoneId) {
  const zone = marketClockZoneById(zoneId)
  const [time, setTime] = useState(() => formatMarketDigitalClock(new Date(), zone.timeZone))

  useEffect(() => {
    const tick = () => setTime(formatMarketDigitalClock(new Date(), zone.timeZone))
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [zone.timeZone])

  return { time, zone }
}
