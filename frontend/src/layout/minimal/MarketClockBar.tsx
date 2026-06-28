import { useEffect, useMemo, useState } from 'react'

import { useMarketClock } from '../../hooks/useMarketClock'
import { useMarketStatus } from '../../hooks/useMarketStatus'
import {
  getUsMarketSession,
  loadMarketClockZone,
  MARKET_CLOCK_ZONES,
  saveMarketClockZone,
  usMarketSessionLabel,
  type MarketClockZoneId,
  type UsMarketSession,
} from '../../lib/marketClock'

const SESSION_DOT_CLASS: Record<string, string> = {
  open: 'ms-market-dot--open',
  'pre-market': 'ms-market-dot--pre',
  pre: 'ms-market-dot--pre',
  regular: 'ms-market-dot--open',
  'post-market': 'ms-market-dot--pre',
  after: 'ms-market-dot--pre',
  closed: 'ms-market-dot--closed',
}

function friendlyMarketError(message: string): string {
  const normalized = message.trim().toLowerCase()
  if (normalized === 'not found') {
    return 'Market status API unavailable — showing estimated US hours'
  }
  if (normalized.includes('finnhub_api_key')) {
    return 'Finnhub key missing — showing estimated US hours'
  }
  return message
}

export default function MarketClockBar() {
  const [zoneId, setZoneId] = useState<MarketClockZoneId>(() => loadMarketClockZone())
  const { time, zone } = useMarketClock(zoneId)
  const { label, isOpen, session, error } = useMarketStatus('US')
  const fallbackSession = useMemo(() => getUsMarketSession(), [time])

  useEffect(() => {
    saveMarketClockZone(zoneId)
  }, [zoneId])

  const usingFallback = Boolean(error)
  const statusText = usingFallback
    ? `${usMarketSessionLabel(fallbackSession)} · est.`
    : label
  const activeSession: UsMarketSession | string | null = usingFallback
    ? fallbackSession
    : session
  const marketOpen = usingFallback
    ? fallbackSession === 'open' || fallbackSession === 'pre' || fallbackSession === 'after'
    : isOpen

  const dotClass = marketOpen
    ? SESSION_DOT_CLASS[activeSession || 'regular'] || 'ms-market-dot--open'
    : SESSION_DOT_CLASS[activeSession || 'closed'] || 'ms-market-dot--closed'

  return (
    <div className="ms-market-bar" title={usingFallback ? friendlyMarketError(error) : label}>
      <label className="ms-market-bar__zone">
        <select
          className="ms-market-bar__zone-select"
          value={zoneId}
          onChange={event => setZoneId(event.target.value as MarketClockZoneId)}
          aria-label="Select timezone"
        >
          {MARKET_CLOCK_ZONES.map(item => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <time dateTime={time} className="ms-market-bar__time">
        {time}
      </time>
      <span className="ms-market-bar__abbr">{zone.abbr}</span>
      <span className={`ms-market-bar__dot ${dotClass}`} aria-hidden="true" />
      <span className="ms-market-bar__status">{statusText}</span>
    </div>
  )
}
