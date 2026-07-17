import { useEffect, useMemo, useState } from 'react'

import { formatBrokerMoney } from '../../lib/currency'
import {
  fetchCompanyNews,
  formatNewsTimestamp,
  type CompanyNewsItem,
} from '../../lib/companyNews'
import type { WatchlistSanitizedCandle } from '../../lib/watchlistCandles'
import {
  loadMomentumTrades,
  WL_MOMENTUM_TRADE_EVENT,
  type MomentumTrade,
} from '../../lib/watchlistMomentumState'
import './HomeQuickInsights.css'

type QuickInsightsSelection = {
  broker: string
  symboltoken: string
  tradingsymbol: string
}

type HourTA = {
  changePct: number
  high: number
  low: number
  sma: number
  close: number
  bars: number
  aboveSma: boolean
}

function computeHourTA(candles: WatchlistSanitizedCandle[]): HourTA | null {
  if (candles.length < 2) return null
  const latest = candles[candles.length - 1]
  const cutoff = latest.time - 3600
  const window = candles.filter(candle => candle.time >= cutoff)
  if (window.length < 2) return null
  const first = window[0]
  const start = first.open || first.close
  if (!start) return null
  const close = latest.close
  const changePct = ((close - start) / start) * 100
  const high = Math.max(...window.map(candle => candle.high))
  const low = Math.min(...window.map(candle => candle.low))
  const sma = window.reduce((sum, candle) => sum + candle.close, 0) / window.length
  return {
    changePct,
    high,
    low,
    sma,
    close,
    bars: window.length,
    aboveSma: close >= sma,
  }
}

function trendVerdict(ta: HourTA): { label: string; tone: 'up' | 'down' | 'flat' } {
  if (ta.changePct > 0.3) return { label: 'Uptrend', tone: 'up' }
  if (ta.changePct < -0.3) return { label: 'Downtrend', tone: 'down' }
  return { label: 'Sideways', tone: 'flat' }
}

function fmtPct(value: number): string {
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

export default function HomeQuickInsights({
  selection,
  newsSymbol,
  candles,
  collapsed,
  onToggle,
}: {
  selection: QuickInsightsSelection
  newsSymbol: string
  candles: WatchlistSanitizedCandle[]
  collapsed: boolean
  onToggle: () => void
}) {
  const [news, setNews] = useState<CompanyNewsItem[]>([])
  const [newsLoading, setNewsLoading] = useState(false)
  const [newsError, setNewsError] = useState('')
  const [tradesVersion, setTradesVersion] = useState(0)

  useEffect(() => {
    if (collapsed || !newsSymbol) return
    let cancelled = false
    setNewsLoading(true)
    setNewsError('')
    fetchCompanyNews(newsSymbol, 7)
      .then(items => {
        if (cancelled) return
        const sorted = [...items].sort((a, b) => (b.datetime || 0) - (a.datetime || 0))
        setNews(sorted.slice(0, 3))
      })
      .catch(err => {
        if (cancelled) return
        setNewsError(err instanceof Error ? err.message : 'Failed to load news')
      })
      .finally(() => {
        if (!cancelled) setNewsLoading(false)
      })
    return () => { cancelled = true }
  }, [newsSymbol, collapsed])

  useEffect(() => {
    const bump = () => setTradesVersion(v => v + 1)
    window.addEventListener(WL_MOMENTUM_TRADE_EVENT, bump)
    return () => window.removeEventListener(WL_MOMENTUM_TRADE_EVENT, bump)
  }, [])

  const activeTrades = useMemo(() => {
    void tradesVersion
    const token = String(selection.symboltoken)
    return loadMomentumTrades()
      .filter((trade: MomentumTrade) => String(trade.symboltoken) === token)
      .slice(0, 4)
  }, [selection.symboltoken, tradesVersion])

  const ta = useMemo(() => computeHourTA(candles), [candles])

  if (collapsed) {
    return (
      <div className="hm-qi hm-qi--collapsed">
        <button
          type="button"
          className="hm-qi__rail-btn"
          onClick={onToggle}
          aria-label="Show quick insights"
          title="Show quick insights"
        >
          <span className="hm-qi__rail-label">Quick insights</span>
          <span aria-hidden="true">◂</span>
        </button>
      </div>
    )
  }

  return (
    <section className="hm-card hm-qi">
      <div className="hm-qi__head">
        <span className="hm-qi__title">Quick insights</span>
        <button
          type="button"
          className="hm-qi__collapse"
          onClick={onToggle}
          aria-label="Hide quick insights"
          title="Hide quick insights"
        >
          ▸
        </button>
      </div>

      <div className="hm-qi__body">
        <div className="hm-qi__section hm-qi__section--news">
          <div className="hm-qi__section-title">Top news</div>
          {newsLoading ? (
            <div className="hm-qi__muted">Loading news…</div>
          ) : newsError ? (
            <div className="hm-qi__muted hm-qi__muted--err">{newsError}</div>
          ) : news.length === 0 ? (
            <div className="hm-qi__muted">No recent news.</div>
          ) : (
            <ul className="hm-qi__news">
              {news.map(item => (
                <li key={item.id} className="hm-qi__news-row">
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="hm-qi__news-link"
                    title={item.headline}
                  >
                    {item.headline}
                  </a>
                  <span className="hm-qi__news-meta">
                    {item.source}{item.datetime ? ` · ${formatNewsTimestamp(item.datetime)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="hm-qi__section hm-qi__section--trades">
          <div className="hm-qi__section-title">
            Active momentum trades
            {activeTrades.length ? <span className="hm-qi__badge">{activeTrades.length}</span> : null}
          </div>
          {activeTrades.length === 0 ? (
            <div className="hm-qi__muted">No momentum trades for {selection.tradingsymbol}.</div>
          ) : (
            <ul className="hm-qi__trades">
              {activeTrades.map(trade => (
                <li key={trade.id} className="hm-qi__trade-row">
                  <span className={`hm-qi__env hm-qi__env--${trade.accountEnv}`}>
                    {trade.accountEnv}
                  </span>
                  <span className="hm-qi__trade-sym">{trade.tradingsymbol}</span>
                  <span className="hm-qi__trade-detail">
                    entry {formatBrokerMoney(trade.broker, trade.entryPrice)}
                    {' · '}{trade.noTakeProfit ? 'no TP' : '5% TP'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="hm-qi__section hm-qi__section--technical">
          <div className="hm-qi__section-title">Technical · past 1h</div>
          {!ta ? (
            <div className="hm-qi__muted">Not enough candle history yet.</div>
          ) : (
            <>
              <div className="hm-qi__ta-row">
                <span className={`hm-qi__verdict hm-qi__verdict--${trendVerdict(ta).tone}`}>
                  {trendVerdict(ta).label}
                </span>
                <span className={`hm-qi__change hm-qi__change--${ta.changePct >= 0 ? 'up' : 'down'}`}>
                  {fmtPct(ta.changePct)}
                </span>
              </div>
              <div className="hm-qi__ta-grid">
                <div className="hm-qi__ta-cell">
                  <span className="hm-qi__ta-label">1h High</span>
                  <span className="hm-qi__ta-val">{formatBrokerMoney(selection.broker, ta.high)}</span>
                </div>
                <div className="hm-qi__ta-cell">
                  <span className="hm-qi__ta-label">1h Low</span>
                  <span className="hm-qi__ta-val">{formatBrokerMoney(selection.broker, ta.low)}</span>
                </div>
                <div className="hm-qi__ta-cell">
                  <span className="hm-qi__ta-label">SMA {ta.bars}</span>
                  <span className="hm-qi__ta-val">{formatBrokerMoney(selection.broker, ta.sma)}</span>
                </div>
                <div className="hm-qi__ta-cell">
                  <span className="hm-qi__ta-label">vs SMA</span>
                  <span className={`hm-qi__ta-val hm-qi__ta-val--${ta.aboveSma ? 'up' : 'down'}`}>
                    {ta.aboveSma ? 'Above' : 'Below'}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
