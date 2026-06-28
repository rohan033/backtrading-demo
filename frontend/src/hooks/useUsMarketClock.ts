import { useEffect, useState } from 'react'

import {
  formatUsMarketDigitalClock,
  getUsMarketSession,
  type UsMarketSession,
} from '../lib/usMarketClock'

export function useUsMarketClock() {
  const [time, setTime] = useState(() => formatUsMarketDigitalClock())
  const [session, setSession] = useState<UsMarketSession>(() => getUsMarketSession())

  useEffect(() => {
    const tick = () => {
      const now = new Date()
      setTime(formatUsMarketDigitalClock(now))
      setSession(getUsMarketSession(now))
    }

    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [])

  return { time, session }
}
