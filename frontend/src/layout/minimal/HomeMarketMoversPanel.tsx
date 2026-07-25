import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { YahooExtendedMetrics } from '../../components/market/YahooExtendedMetrics'
import { YahooPriceCardToggle } from '../../components/market/YahooPriceCardToggle'
import {
  usePerCardYahooPrice,
  useYahooExtendedQuote,
} from '../../hooks/useYahooExtendedQuotes'
import {
  fetchScreeners,
  refreshScreener,
  type Screener,
  type ScreenerResultRow,
} from '../../lib/screenerApi'
import { tickerSymbol, yahooFinanceUrl } from '../../lib/screenerDefinition'
import { safeSetItem } from '../../lib/safeStorage'
import { YAHOO_QUOTE_STAGGER_MS, yahooQuoteMetrics } from '../../lib/yahooFinanceApi'
import {
  formatHomeMoverAbs,
  formatHomeMoverPct,
  formatHomeMoverPrice,
  homeMoverMetrics,
  homeMoverPctArrow,
  homeMoverPctTone,
  homeMoversSession,
  homeMoversSessionHeadline,
  homeMoversScreenerName,
  HOME_MOVERS_MAX_CARDS,
  HOME_MOVERS_REFRESH_SECONDS,
  sortHomeMoverRows,
} from '../../lib/homeMarketMovers'
import './HomeMarketMoversPanel.css'

const HOME_MOVERS_SCREENER_KEY = 'home-movers-screener-id'
const AUTO_SCREENER_OPTION = '__auto__'

function loadManualScreenerId(): string | null {
  try {
    return localStorage.getItem(HOME_MOVERS_SCREENER_KEY)
  } catch {
    return null
  }
}

function screenerRefreshSeconds(screener: Screener | null): number {
  const configured = Number(screener?.auto_refresh_seconds || 0)
  return configured > 0 ? configured : HOME_MOVERS_REFRESH_SECONDS
}

type HomeMoverCardProps = {
  row: ScreenerResultRow
  sourceType: Screener['source_type'] | undefined
  pctPrevByTicker: Record<string, number>
  yahooGeneration: number
  staggerMs: number
}

function HomeMoverCard({
  row,
  sourceType,
  pctPrevByTicker,
  yahooGeneration,
  staggerMs,
}: HomeMoverCardProps) {
  const ticker = row.ticker
  const symbol = tickerSymbol(ticker)
  const {
    yahooPriceEnabled,
    yahooPriceChecked,
    setYahooPriceEnabled,
    showYahooToggle,
  } = usePerCardYahooPrice()
  const {
    quote: yahooQuote,
    previousPct: yahooPreviousPct,
    loading: yahooLoading,
    useYahooQuote,
    extendedActive: yahooExtendedActive,
  } = useYahooExtendedQuote(ticker, {
    enabled: yahooPriceEnabled,
    generation: yahooGeneration,
    staggerMs,
  })
  const metrics = useYahooQuote && yahooQuote
    ? yahooQuoteMetrics(yahooQuote)
    : homeMoverMetrics(row, sourceType)
  const tone = homeMoverPctTone(metrics.pct)
  const previousPct = useYahooQuote
    ? yahooPreviousPct
    : pctPrevByTicker[ticker.toUpperCase()]
  const arrow = homeMoverPctArrow(metrics.pct, previousPct)
  const yahooUrl = yahooFinanceUrl(ticker)
  const isYahooLoading = yahooExtendedActive && yahooLoading

  return (
    <article
      className={`hm-mover-card${useYahooQuote ? ' hm-mover-card--yahoo' : ''}${isYahooLoading ? ' hm-mover-card--yahoo-loading' : ''}`}
    >
      <header className="hm-mover-card__head">
        {yahooUrl ? (
          <a
            className="hm-mover-card__symbol"
            href={yahooUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open ${symbol} on Yahoo Finance`}
          >
            {symbol}
          </a>
        ) : (
          <span className="hm-mover-card__symbol">{symbol}</span>
        )}
        {showYahooToggle ? (
          <YahooPriceCardToggle
            checked={yahooPriceChecked}
            onChange={setYahooPriceEnabled}
          />
        ) : null}
      </header>
      <div className="hm-mover-card__body">
        {useYahooQuote && yahooQuote ? (
          <YahooExtendedMetrics
            quote={yahooQuote}
            previousPct={previousPct}
            compact
          />
        ) : (
          <>
            <div className="hm-mover-card__pct-row">
              <div className={`hm-mover-card__pct hm-mover-card__pct--${tone}`}>
                {formatHomeMoverPct(metrics.pct)}
              </div>
              {arrow === 'up' ? (
                <span
                  className="hm-mover-pct-arrow hm-mover-pct-arrow--up"
                  title="Change % increased since last refresh"
                  aria-hidden
                >
                  ↑
                </span>
              ) : null}
              {arrow === 'down' ? (
                <span
                  className="hm-mover-pct-arrow hm-mover-pct-arrow--down"
                  title="Change % decreased since last refresh"
                  aria-hidden
                >
                  ↓
                </span>
              ) : null}
              {arrow === 'flat' ? (
                <span
                  className="hm-mover-pct-arrow hm-mover-pct-arrow--flat"
                  title="Change % unchanged since last refresh"
                  aria-hidden
                >
                  →
                </span>
              ) : null}
            </div>
            <div className="hm-mover-card__meta">
              <span className="hm-mover-card__price">{formatHomeMoverPrice(metrics.price)}</span>
              <span className={`hm-mover-card__abs hm-mover-card__abs--${tone}`}>
                {formatHomeMoverAbs(metrics.changeAbs)}
              </span>
            </div>
          </>
        )}
      </div>
    </article>
  )
}

export default function HomeMarketMoversPanel() {
  const [screeners, setScreeners] = useState<Screener[]>([])
  const [active, setActive] = useState<Screener | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [session, setSession] = useState(() => homeMoversSession())
  const [pctPrevByTicker, setPctPrevByTicker] = useState<Record<string, number>>({})
  const [refreshRemainingPct, setRefreshRemainingPct] = useState(100)
  const refreshInFlight = useRef(false)
  const refreshCycleStartRef = useRef(Date.now())
  const visibleRef = useRef(typeof document !== 'undefined' ? document.visibilityState === 'visible' : true)
  const prevPctRef = useRef<Record<string, number>>({})
  const lastRefreshKeyRef = useRef('')
  const lastScreenerIdRef = useRef('')
  const [yahooGeneration, setYahooGeneration] = useState(0)
  const [manualScreenerId, setManualScreenerId] = useState<string | null>(() => loadManualScreenerId())

  const targetName = useMemo(() => homeMoversScreenerName(session), [session])
  const autoScreener = useMemo(
    () => screeners.find(item => item.name.trim().toLowerCase() === targetName.trim().toLowerCase()) ?? null,
    [screeners, targetName],
  )
  const manualScreener = useMemo(
    () => (manualScreenerId ? screeners.find(item => item.id === manualScreenerId) ?? null : null),
    [manualScreenerId, screeners],
  )
  const targetScreener = manualScreener ?? autoScreener
  const refreshSeconds = screenerRefreshSeconds(targetScreener)

  const sortedScreeners = useMemo(
    () => [...screeners].sort((a, b) => a.name.localeCompare(b.name)),
    [screeners],
  )

  const handleScreenerSelect = useCallback((value: string) => {
    if (value === AUTO_SCREENER_OPTION) {
      setManualScreenerId(null)
      try {
        localStorage.removeItem(HOME_MOVERS_SCREENER_KEY)
      } catch {
        // ignore storage failures
      }
      return
    }
    setManualScreenerId(value)
    safeSetItem(HOME_MOVERS_SCREENER_KEY, value)
  }, [])

  const loadScreeners = useCallback(async () => {
    const items = await fetchScreeners(false)
    setScreeners(items)
    return items
  }, [])

  const runRefresh = useCallback(async (screenerId: string) => {
    if (refreshInFlight.current) return null
    refreshInFlight.current = true
    setRefreshing(true)
    try {
      const updated = await refreshScreener(screenerId)
      setActive(updated)
      setError('')
      setYahooGeneration(prev => prev + 1)
      return updated
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh movers')
      return null
    } finally {
      refreshInFlight.current = false
      setRefreshing(false)
      setLoading(false)
      refreshCycleStartRef.current = Date.now()
      setRefreshRemainingPct(100)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    void loadScreeners()
      .catch(err => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load screeners')
          setLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [loadScreeners])

  useEffect(() => {
    if (!targetScreener?.id) {
      setActive(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    void runRefresh(targetScreener.id).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [runRefresh, targetScreener?.id])

  useEffect(() => {
    const tick = () => setSession(homeMoversSession())
    tick()
    const id = window.setInterval(tick, 60_000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    const onVis = () => {
      visibleRef.current = document.visibilityState === 'visible'
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  useEffect(() => {
    if (!targetScreener?.id) {
      setRefreshRemainingPct(100)
      return undefined
    }

    const totalMs = refreshSeconds * 1000
    refreshCycleStartRef.current = Date.now()
    setRefreshRemainingPct(100)

    const tick = window.setInterval(() => {
      if (!visibleRef.current) {
        refreshCycleStartRef.current = Date.now()
        setRefreshRemainingPct(100)
        return
      }
      const elapsed = Date.now() - refreshCycleStartRef.current
      if (elapsed >= totalMs) {
        refreshCycleStartRef.current = Date.now()
        setRefreshRemainingPct(100)
        void runRefresh(targetScreener.id)
        return
      }
      setRefreshRemainingPct(Math.max(0, 100 * (1 - elapsed / totalMs)))
    }, 200)

    return () => window.clearInterval(tick)
  }, [refreshSeconds, runRefresh, targetScreener?.id])

  useEffect(() => {
    if (!active?.results?.length || !active.id) {
      setPctPrevByTicker({})
      return
    }

    const refreshKey = active.last_refreshed_at || active.updated_at || ''
    if (!refreshKey) return

    if (lastScreenerIdRef.current !== active.id) {
      lastScreenerIdRef.current = active.id
      lastRefreshKeyRef.current = ''
      prevPctRef.current = {}
      setPctPrevByTicker({})
    }

    const snapshot: Record<string, number> = {}
    for (const row of active.results) {
      const pct = homeMoverMetrics(row, active.source_type).pct
      if (pct != null) snapshot[row.ticker.toUpperCase()] = pct
    }

    if (refreshKey !== lastRefreshKeyRef.current) {
      if (lastRefreshKeyRef.current) {
        setPctPrevByTicker({ ...prevPctRef.current })
      } else {
        setPctPrevByTicker({})
      }
      prevPctRef.current = snapshot
      lastRefreshKeyRef.current = refreshKey
    }
  }, [
    active?.id,
    active?.last_refreshed_at,
    active?.results,
    active?.source_type,
    active?.updated_at,
  ])

  const rows = useMemo(() => {
    if (!active?.results?.length) return []
    return sortHomeMoverRows(active.results, active.source_type).slice(0, HOME_MOVERS_MAX_CARDS)
  }, [active])

  const sessionHeadline = homeMoversSessionHeadline(session)
  const lastRefreshed = active?.last_refreshed_at
    ? new Date(active.last_refreshed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null
  const refreshSecondsRemaining = Math.max(
    0,
    Math.ceil((refreshRemainingPct / 100) * refreshSeconds),
  )

  return (
    <section className="hm-card hm-movers-panel" aria-label="Market movers">
      <header className="hm-movers-panel__head">
        <div className="hm-movers-panel__head-main">
          <div className="hm-movers-panel__title-wrap">
            <div className={`hm-movers-panel__headline hm-movers-panel__headline--${session}`}>
              {sessionHeadline}
            </div>
            <div className="hm-movers-panel__controls">
              <label className="hm-movers-panel__screener-picker">
                <span className="hm-movers-panel__screener-label">Screener</span>
                <select
                  className="hm-movers-panel__screener-select"
                  value={manualScreenerId ?? AUTO_SCREENER_OPTION}
                  onChange={event => handleScreenerSelect(event.target.value)}
                  aria-label="Select screener for movers"
                >
                  <option value={AUTO_SCREENER_OPTION}>
                    Auto{autoScreener ? ` · ${autoScreener.name}` : ` · ${targetName}`}
                  </option>
                  {sortedScreeners.map(item => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="hm-movers-panel__subtitle">
              {manualScreener ? 'Manual · ' : 'Auto · '}
              {targetScreener?.name ?? targetName}
              {' · '}
              {refreshSeconds}
              s
              {lastRefreshed ? ` · ${lastRefreshed}` : ''}
            </div>
          </div>
          <div className="hm-movers-panel__head-aside">
            {targetScreener?.id ? (
              <div
                className="hm-movers-panel__refresh-bar"
                role="progressbar"
                aria-label="Time until next auto refresh"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(refreshRemainingPct)}
                title={`Next refresh in ${refreshSecondsRemaining}s`}
              >
                <div className="hm-movers-panel__refresh-bar-track">
                  <div
                    className="hm-movers-panel__refresh-bar-fill"
                    style={{ width: `${refreshRemainingPct}%` }}
                  />
                </div>
                <span className="hm-movers-panel__refresh-count" aria-hidden>
                  {refreshSecondsRemaining}
                </span>
              </div>
            ) : null}
            <button
              type="button"
              className="hm-movers-panel__refresh"
              onClick={() => {
                if (!targetScreener?.id) return
                refreshCycleStartRef.current = Date.now()
                setRefreshRemainingPct(100)
                void runRefresh(targetScreener.id)
              }}
              disabled={!targetScreener?.id || refreshing}
              title="Refresh movers"
            >
              {refreshing ? '…' : '↻'}
            </button>
          </div>
        </div>
      </header>

      <div className="hm-movers-panel__body">
        {loading && !rows.length ? (
          <div className="hm-movers-panel__empty">Loading movers…</div>
        ) : null}
        {!loading && !targetScreener ? (
          <div className="hm-movers-panel__empty">
            Screener “{targetName}” not found. Open Screeners once to seed built-ins.
          </div>
        ) : null}
        {error && !rows.length ? (
          <div className="hm-movers-panel__empty hm-movers-panel__empty--error">{error}</div>
        ) : null}
        {!rows.length && targetScreener && !loading && !error ? (
          <div className="hm-movers-panel__empty">No movers yet.</div>
        ) : null}
        {rows.length ? (
          <div className="hm-movers-panel__grid">
            {rows.map((row, index) => (
              <HomeMoverCard
                key={row.id || row.ticker}
                row={row}
                sourceType={active?.source_type}
                pctPrevByTicker={pctPrevByTicker}
                yahooGeneration={yahooGeneration}
                staggerMs={index * YAHOO_QUOTE_STAGGER_MS}
              />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  )
}
