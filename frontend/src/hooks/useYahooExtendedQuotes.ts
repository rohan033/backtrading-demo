import { useEffect, useRef, useState } from 'react'

import { getUsMarketSession, type UsMarketSession } from '../lib/marketClock'
import {
  fetchYahooExtendedQuote,
  loadYahooExtendedHoursEnabled,
  saveYahooExtendedHoursEnabled,
  sleep,
  yahooQuoteKey,
  YAHOO_EXTENDED_HOURS_KEY,
  type YahooExtendedQuote,
} from '../lib/yahooFinanceApi'

export function isUsExtendedHoursSession(session: UsMarketSession): boolean {
  return session === 'pre' || session === 'after'
}

export function useYahooExtendedSession() {
  const [session, setSession] = useState<UsMarketSession>(() => getUsMarketSession())

  useEffect(() => {
    const tick = () => setSession(getUsMarketSession())
    tick()
    const id = window.setInterval(tick, 60_000)
    return () => window.clearInterval(id)
  }, [])

  return {
    session,
    extendedActive: isUsExtendedHoursSession(session),
  }
}

/** Per-card Yahoo price opt-in. Off by default so cards do not hit rate limits together. */
export function usePerCardYahooPrice() {
  const [enabled, setEnabled] = useState(false)
  const { extendedActive } = useYahooExtendedSession()
  return {
    yahooPriceEnabled: enabled && extendedActive,
    yahooPriceChecked: enabled,
    setYahooPriceEnabled: setEnabled,
    showYahooToggle: extendedActive,
  }
}

export function useYahooExtendedHoursSetting() {
  const [enabled, setEnabled] = useState(() => loadYahooExtendedHoursEnabled())

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === YAHOO_EXTENDED_HOURS_KEY) {
        setEnabled(loadYahooExtendedHoursEnabled())
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setEnabledPersisted = (next: boolean) => {
    setEnabled(next)
    saveYahooExtendedHoursEnabled(next)
  }

  return { enabled, setEnabled: setEnabledPersisted }
}

export function useYahooExtendedQuote(
  ticker: string,
  {
    enabled,
    generation = 0,
    active = true,
    staggerMs = 0,
  }: {
    enabled: boolean
    generation?: number
    active?: boolean
    staggerMs?: number
  },
) {
  const [session, setSession] = useState<UsMarketSession>(() => getUsMarketSession())
  const [quote, setQuote] = useState<YahooExtendedQuote | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previousPct, setPreviousPct] = useState<number | null>(null)
  const quoteRef = useRef<YahooExtendedQuote | null>(null)
  const runIdRef = useRef(0)

  const extendedActive = enabled && active && isUsExtendedHoursSession(session)

  useEffect(() => {
    const tick = () => setSession(getUsMarketSession())
    tick()
    const id = window.setInterval(tick, 60_000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    if (generation > 0) {
      setPreviousPct(quoteRef.current?.change_pct ?? null)
    }
  }, [generation])

  useEffect(() => {
    if (!extendedActive) {
      setLoading(false)
      return undefined
    }

    const key = yahooQuoteKey(ticker)
    if (!key) return undefined

    const runId = runIdRef.current + 1
    runIdRef.current = runId
    let cancelled = false

    const run = async () => {
      if (staggerMs > 0) {
        await sleep(staggerMs)
      }
      if (cancelled || runIdRef.current !== runId) return

      setLoading(true)
      setError(null)
      try {
        const next = await fetchYahooExtendedQuote(key)
        if (cancelled || runIdRef.current !== runId) return
        quoteRef.current = next
        if (next.extended_hours) {
          setQuote(next)
        } else {
          setQuote(null)
        }
      } catch (err) {
        if (cancelled || runIdRef.current !== runId) return
        setError(err instanceof Error ? err.message : 'Yahoo quote failed')
      } finally {
        if (!cancelled && runIdRef.current === runId) {
          setLoading(false)
        }
      }
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [extendedActive, generation, staggerMs, ticker])

  const useYahooQuote = Boolean(
    quote?.extended_hours
    && quote.price != null
    && quote.change_pct != null,
  )

  return {
    session,
    extendedActive,
    quote: useYahooQuote ? quote : null,
    loading,
    error,
    previousPct,
    useYahooQuote,
  }
}
