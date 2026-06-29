import { useEffect, useMemo, useState } from 'react'
import './ResearchTable.css'
import {
  coerceInsiderChange,
  fetchEarningsCalendar,
  fetchFilingSentiment,
  fetchInsiderTransactions,
  fetchRecommendationTrends,
  fetchSecFilings,
  finnhubSymbol,
  formatCompactMoney,
  formatEarningsHour,
  formatFilingDate,
  formatInsiderSideLabel,
  formatPolarityScore,
  formatRecommendationPeriod,
  formatSentimentShare,
  formatShareCount,
  formatTransactionCode,
  isUpcomingEarnings,
  readRecommendationField,
  recommendationLegendLabel,
  recommendationSegments,
  recommendationTotal,
  resolveInsiderSide,
  type EarningsEvent,
  type FilingSentiment,
  type InsiderTransaction,
  type RecommendationTrend,
  type SecFiling,
} from '../../lib/marketResearch'

function PanelMessage({ children }: { children: React.ReactNode }) {
  return <p className="hm-panel-message">{children}</p>
}

function PanelError({ message }: { message: string }) {
  return <p className="hm-panel-message hm-panel-message--error">{message}</p>
}

function ResearchTableShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="hm-r-table-scroll">
      <div className="hm-r-table-card">{children}</div>
    </div>
  )
}

function RecommendationBar({ row }: { row: RecommendationTrend }) {
  const segments = useMemo(() => recommendationSegments(row), [row])
  const total = recommendationTotal(row)

  if (!total) {
    return <div className="hm-rec-bar hm-rec-bar--empty">No analyst counts for this period</div>
  }

  return (
    <div className="hm-rec-bar" aria-label="Recommendation distribution">
      {segments.map(segment => {
        if (!segment.count) return null
        const width = (segment.count / total) * 100
        return (
          <div
            key={segment.key}
            className={`hm-rec-bar-seg hm-rec-bar-seg--${segment.className}`}
            style={{ width: `${width}%` }}
            title={`${segment.label}: ${segment.count}`}
          />
        )
      })}
    </div>
  )
}

export function HomeRecommendationsPanel({ symbol }: { symbol: string }) {
  const [items, setItems] = useState<RecommendationTrend[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    fetchRecommendationTrends(symbol, { limit: 8 })
      .then(rows => {
        if (cancelled) return
        setItems(rows)
      })
      .catch(err => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load recommendation trends')
        setItems([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [symbol])

  const latest = items[0]
  const latestSegments = useMemo(
    () => (latest ? recommendationSegments(latest) : []),
    [latest],
  )
  const latestTotal = latest ? recommendationTotal(latest) : 0

  if (loading) return <PanelMessage>Loading analyst recommendations…</PanelMessage>
  if (error) return <PanelError message={error} />
  if (!items.length) {
    return (
      <PanelMessage>
        No recommendation trends found for {finnhubSymbol(symbol)}. Finnhub covers US-listed symbols.
      </PanelMessage>
    )
  }

  return (
    <div className="hm-rec-panel">
      {latest ? (
        <div className="hm-rec-latest">
          <div className="hm-rec-latest-head">
            <span className="hm-rec-latest-label">Latest · {formatRecommendationPeriod(latest.period)}</span>
            <span className="hm-rec-latest-total">{latestTotal.toLocaleString()} analysts</span>
          </div>
          <RecommendationBar row={latest} />
          <div className="hm-rec-legend">
            {latestSegments.map(segment => (
              <span key={segment.key} className={`hm-rec-legend-item hm-rec-legend-item--${segment.className}`}>
                <span className="hm-rec-legend-dot" aria-hidden="true" />
                {recommendationLegendLabel(segment.key)} {segment.count}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="hm-rec-table-scroll">
        <table className="hm-r-table">
          <colgroup>
            <col className="hm-r-col-rec-period" />
            <col className="hm-r-col-rec-extreme" />
            <col className="hm-r-col-rec-num" />
            <col className="hm-r-col-rec-num" />
            <col className="hm-r-col-rec-num" />
            <col className="hm-r-col-rec-extreme" />
          </colgroup>
          <thead>
            <tr className="hm-r-thead-row">
              <th className="hm-r-th">Period</th>
              <th className="hm-r-th hm-r-th--right">Str+</th>
              <th className="hm-r-th hm-r-th--right">Buy</th>
              <th className="hm-r-th hm-r-th--right">Hold</th>
              <th className="hm-r-th hm-r-th--right">Sell</th>
              <th className="hm-r-th hm-r-th--right">Str−</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr key={item.period || `${item.symbol}-row`} className="hm-r-table-row">
                <td className="hm-r-td">{formatRecommendationPeriod(item.period)}</td>
                <td className="hm-r-td hm-r-td--num hm-r-td--rec-extreme hm-r-td--rec-strong-buy">
                  {readRecommendationField(item, 'strongBuy')}
                </td>
                <td className="hm-r-td hm-r-td--num">{readRecommendationField(item, 'buy')}</td>
                <td className="hm-r-td hm-r-td--num">{readRecommendationField(item, 'hold')}</td>
                <td className="hm-r-td hm-r-td--num">{readRecommendationField(item, 'sell')}</td>
                <td className="hm-r-td hm-r-td--num hm-r-td--rec-extreme hm-r-td--rec-strong-sell">
                  {readRecommendationField(item, 'strongSell')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function HomeFilingsPanel({ symbol }: { symbol: string }) {
  const [items, setItems] = useState<SecFiling[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    fetchSecFilings(symbol, { days: 365, limit: 50 })
      .then(rows => {
        if (cancelled) return
        setItems(rows)
      })
      .catch(err => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load filings')
        setItems([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [symbol])

  if (loading) return <PanelMessage>Loading SEC filings…</PanelMessage>
  if (error) return <PanelError message={error} />
  if (!items.length) {
    return (
      <PanelMessage>
        No SEC filings found for {finnhubSymbol(symbol)}. Finnhub filings cover US-listed symbols.
      </PanelMessage>
    )
  }

  return (
    <ResearchTableShell>
      <table className="hm-r-table">
        <colgroup>
          <col className="hm-r-col-form" />
          <col className="hm-r-col-date" />
          <col className="hm-r-col-access" />
          <col className="hm-r-col-links" />
        </colgroup>
        <thead>
          <tr className="hm-r-thead-row">
            <th className="hm-r-th">Form</th>
            <th className="hm-r-th">Filed</th>
            <th className="hm-r-th">Access #</th>
            <th className="hm-r-th">Links</th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => (
            <tr key={item.accessNumber} className="hm-r-table-row">
              <td className="hm-r-td">
                <span className="hm-r-badge">{item.form || 'SEC'}</span>
              </td>
              <td className="hm-r-td">{formatFilingDate(item.filedDate || item.acceptedDate)}</td>
              <td className="hm-r-td hm-r-td--mono">{item.accessNumber}</td>
              <td className="hm-r-td">
                {item.reportUrl ? (
                  <a className="hm-r-link" href={item.reportUrl} target="_blank" rel="noopener noreferrer">
                    Report
                  </a>
                ) : null}
                {item.filingUrl ? (
                  <a className="hm-r-link" href={item.filingUrl} target="_blank" rel="noopener noreferrer">
                    Filing index
                  </a>
                ) : null}
                {!item.reportUrl && !item.filingUrl ? '—' : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ResearchTableShell>
  )
}

function earningsEpsCell(event: EarningsEvent) {
  const upcoming = isUpcomingEarnings(event)
  const epsActual = event.epsActual
  const epsEstimate = event.epsEstimate
  const beat = !upcoming && epsActual != null && epsEstimate != null && epsActual >= epsEstimate

  if (upcoming) {
    return (
      <>
        <div className="hm-r-val hm-r-val--pending">
          {epsEstimate != null ? epsEstimate.toFixed(2) : '—'}
        </div>
        <div className="hm-r-sub">consensus est</div>
      </>
    )
  }

  return (
    <>
      <div className={`hm-r-val${beat ? ' hm-r-val--up' : ''}`}>
        {epsActual != null ? epsActual.toFixed(2) : '—'}
      </div>
      <div className="hm-r-sub">
        est {epsEstimate != null ? epsEstimate.toFixed(2) : '—'}
      </div>
    </>
  )
}

function earningsRevenueCell(event: EarningsEvent) {
  const upcoming = isUpcomingEarnings(event)
  if (upcoming) {
    return (
      <>
        <div className="hm-r-val hm-r-val--pending">
          {formatCompactMoney(event.revenueEstimate)}
        </div>
        <div className="hm-r-sub">consensus est</div>
      </>
    )
  }

  return (
    <>
      <div className="hm-r-val">{formatCompactMoney(event.revenueActual)}</div>
      <div className="hm-r-sub">
        est {formatCompactMoney(event.revenueEstimate)}
      </div>
    </>
  )
}

export function HomeEarningsPanel({ symbol }: { symbol: string }) {
  const [items, setItems] = useState<EarningsEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    fetchEarningsCalendar(symbol, { pastDays: 180, futureDays: 120 })
      .then(rows => {
        if (cancelled) return
        setItems(rows)
      })
      .catch(err => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load earnings')
        setItems([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [symbol])

  const { upcoming, reported } = useMemo(() => {
    const next: EarningsEvent[] = []
    const past: EarningsEvent[] = []
    for (const item of items) {
      if (isUpcomingEarnings(item)) next.push(item)
      else past.push(item)
    }
    next.sort((a, b) => String(a.date).localeCompare(String(b.date)))
    past.sort((a, b) => String(b.date).localeCompare(String(a.date)))
    return { upcoming: next, reported: past }
  }, [items])

  if (loading) return <PanelMessage>Loading earnings calendar…</PanelMessage>
  if (error) return <PanelError message={error} />
  if (!items.length) {
    return (
      <PanelMessage>
        No earnings events found for {finnhubSymbol(symbol)} in the selected window.
      </PanelMessage>
    )
  }

  const renderTable = (rows: EarningsEvent[]) => (
    <table className="hm-r-table">
      <colgroup>
        <col style={{ width: '22%' }} />
        <col className="hm-r-col-eps" />
        <col className="hm-r-col-rev" />
        <col className="hm-r-col-when" />
      </colgroup>
      <thead>
        <tr className="hm-r-thead-row">
          <th className="hm-r-th">Date</th>
          <th className="hm-r-th">EPS</th>
          <th className="hm-r-th">Rev</th>
          <th className="hm-r-th">When</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(item => {
          const key = `${item.date}-${item.quarter}-${item.year}-${item.hour}`
          return (
            <tr key={key} className="hm-r-table-row">
              <td className="hm-r-td">
                <div className="hm-r-val">{item.date || '—'}</div>
                <div className="hm-r-sub">
                  {item.quarter ? `Q${item.quarter}` : '—'}
                  {item.year ? ` ${item.year}` : ''}
                </div>
              </td>
              <td className="hm-r-td">{earningsEpsCell(item)}</td>
              <td className="hm-r-td">{earningsRevenueCell(item)}</td>
              <td className="hm-r-td">{formatEarningsHour(item.hour)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )

  return (
    <div className="hm-r-section">
      {upcoming.length ? (
        <section className="hm-r-section">
          <h3 className="hm-r-section__title">Upcoming</h3>
          <ResearchTableShell>{renderTable(upcoming)}</ResearchTableShell>
        </section>
      ) : null}
      {reported.length ? (
        <section className="hm-r-section">
          <h3 className="hm-r-section__title">Reported</h3>
          <ResearchTableShell>{renderTable(reported)}</ResearchTableShell>
        </section>
      ) : null}
      {!reported.length && upcoming.length ? (
        <p className="hm-panel-footnote">
          Finnhub free tier may only expose upcoming dates and consensus estimates for this symbol.
        </p>
      ) : null}
    </div>
  )
}

export function HomeInsiderPanel({ symbol }: { symbol: string }) {
  const [items, setItems] = useState<InsiderTransaction[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    fetchInsiderTransactions(symbol, { days: 365 })
      .then(rows => {
        if (cancelled) return
        setItems(rows)
      })
      .catch(err => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load insider transactions')
        setItems([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [symbol])

  if (loading) return <PanelMessage>Loading insider transactions…</PanelMessage>
  if (error) return <PanelError message={error} />
  if (!items.length) {
    return (
      <PanelMessage>
        No insider transactions found for {finnhubSymbol(symbol)} in the last year.
      </PanelMessage>
    )
  }

  return (
    <ResearchTableShell>
      <table className="hm-r-table">
        <colgroup>
          <col style={{ width: '24%' }} />
          <col style={{ width: '10%' }} />
          <col style={{ width: '12%' }} />
          <col style={{ width: '12%' }} />
          <col style={{ width: '14%' }} />
          <col style={{ width: '14%' }} />
          <col style={{ width: '14%' }} />
        </colgroup>
        <thead>
          <tr className="hm-r-thead-row">
            <th className="hm-r-th">Insider</th>
            <th className="hm-r-th">Side</th>
            <th className="hm-r-th">Change</th>
            <th className="hm-r-th">Holdings</th>
            <th className="hm-r-th">Txn date</th>
            <th className="hm-r-th">Filed</th>
            <th className="hm-r-th">Code / price</th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => {
            const key = `${item.name}-${item.transactionDate}-${item.filingDate}-${item.change}-${item.transactionCode}`
            const side = resolveInsiderSide(item)
            const change = coerceInsiderChange(item.change)
            return (
              <tr key={key} className="hm-r-table-row">
                <td className="hm-r-td">
                  <div className="hm-r-val">{item.name || '—'}</div>
                </td>
                <td className="hm-r-td">
                  <span className={`hm-r-side hm-r-side--${side}`}>
                    {formatInsiderSideLabel(item)}
                  </span>
                </td>
                <td className="hm-r-td">
                  <span className={`hm-r-val${side === 'buy' ? ' hm-r-val--up' : side === 'sell' ? ' hm-r-val--down' : ''}`}>
                    {change != null && change > 0 ? '+' : ''}
                    {formatShareCount(change)}
                  </span>
                </td>
                <td className="hm-r-td">{formatShareCount(item.share)}</td>
                <td className="hm-r-td">{formatFilingDate(item.transactionDate)}</td>
                <td className="hm-r-td">{formatFilingDate(item.filingDate)}</td>
                <td className="hm-r-td">
                  <div className="hm-r-sub">{formatTransactionCode(item.transactionCode)}</div>
                  <div className="hm-r-val">{formatCompactMoney(item.transactionPrice)}</div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </ResearchTableShell>
  )
}

const SENTIMENT_FIELDS: Array<{
  key: keyof FilingSentiment | string
  label: string
  tone?: 'pos' | 'neg' | 'neutral'
  format?: 'share' | 'polarity'
}> = [
  { key: 'positive', label: 'Positive', tone: 'pos', format: 'share' },
  { key: 'negative', label: 'Negative', tone: 'neg', format: 'share' },
  { key: 'polarity', label: 'Polarity', tone: 'neutral', format: 'polarity' },
  { key: 'uncertainty', label: 'Uncertainty', tone: 'neutral', format: 'share' },
  { key: 'litigious', label: 'Litigious', tone: 'neg', format: 'share' },
  { key: 'constraining', label: 'Constraining', tone: 'neutral', format: 'share' },
  { key: 'modal-weak', label: 'Modal weak', tone: 'neutral', format: 'share' },
  { key: 'modal-moderate', label: 'Modal moderate', tone: 'neutral', format: 'share' },
  { key: 'modal-strong', label: 'Modal strong', tone: 'neutral', format: 'share' },
]

function sentimentValue(row: FilingSentiment, key: string): number | null {
  if (key in row && typeof row[key as keyof FilingSentiment] === 'number') {
    return row[key as keyof FilingSentiment] as number
  }
  const nested = row.sentiment?.[key]
  return typeof nested === 'number' ? nested : null
}

function formatSentimentMetric(value: number | null, format: 'share' | 'polarity' = 'share'): string {
  if (format === 'polarity') return formatPolarityScore(value, 3)
  return formatSentimentShare(value, 2)
}

type SentimentLoadState =
  | { kind: 'ok'; rows: Array<{ filing: SecFiling; sentiment: FilingSentiment }> }
  | { kind: 'no-targets'; message: string }
  | { kind: 'premium'; targets: SecFiling[] }
  | { kind: 'error'; message: string }

export function HomeSentimentPanel({ symbol }: { symbol: string }) {
  const [state, setState] = useState<SentimentLoadState | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setState(null)

    ;(async () => {
      try {
        const filings = await fetchSecFilings(symbol, { days: 730, limit: 80 })
        const targets = filings
          .filter(item => ['10-K', '10-Q'].includes(String(item.form || '').toUpperCase()))
          .slice(0, 3)

        if (!targets.length) {
          if (!cancelled) {
            setState({
              kind: 'no-targets',
              message: `No 10-K / 10-Q filings found for ${finnhubSymbol(symbol)} in the last two years.`,
            })
          }
          return
        }

        const loaded: Array<{ filing: SecFiling; sentiment: FilingSentiment }> = []
        let premiumBlocked = false

        for (const filing of targets) {
          if (!filing.accessNumber) continue
          try {
            const sentiment = await fetchFilingSentiment(filing.accessNumber)
            loaded.push({ filing, sentiment })
          } catch (err) {
            const message = err instanceof Error ? err.message : ''
            if (/premium|access to this resource|403|502/i.test(message)) {
              premiumBlocked = true
            }
          }
        }

        if (!cancelled) {
          if (loaded.length) {
            setState({ kind: 'ok', rows: loaded })
          } else if (premiumBlocked) {
            setState({ kind: 'premium', targets })
          } else {
            setState({
              kind: 'error',
              message: 'Could not load filing sentiment for the latest 10-K / 10-Q reports.',
            })
          }
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: err instanceof Error ? err.message : 'Failed to load filing sentiment',
          })
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [symbol])

  if (loading) return <PanelMessage>Loading filing sentiment…</PanelMessage>
  if (!state) return <PanelMessage>Loading filing sentiment…</PanelMessage>

  if (state.kind === 'error') return <PanelError message={state.message} />
  if (state.kind === 'no-targets') return <PanelMessage>{state.message}</PanelMessage>

  if (state.kind === 'premium') {
    return (
      <div className="hm-sentiment-stack">
        <PanelMessage>
          SEC filing sentiment is a Finnhub premium endpoint. Latest 10-K / 10-Q filings for{' '}
          {finnhubSymbol(symbol)} are listed below; scores are unavailable on the current API key.
        </PanelMessage>
        <ResearchTableShell>
          <table className="hm-r-table">
            <colgroup>
              <col className="hm-r-col-form" />
              <col className="hm-r-col-date" />
              <col className="hm-r-col-access" />
            </colgroup>
            <thead>
              <tr className="hm-r-thead-row">
                <th className="hm-r-th">Form</th>
                <th className="hm-r-th">Filed</th>
                <th className="hm-r-th">Access #</th>
              </tr>
            </thead>
            <tbody>
              {state.targets.map(filing => (
                <tr key={filing.accessNumber} className="hm-r-table-row">
                  <td className="hm-r-td">
                    <span className="hm-r-badge">{filing.form || 'SEC'}</span>
                  </td>
                  <td className="hm-r-td">{formatFilingDate(filing.filedDate || filing.acceptedDate)}</td>
                  <td className="hm-r-td hm-r-td--mono">{filing.accessNumber}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ResearchTableShell>
      </div>
    )
  }

  return (
    <div className="hm-sentiment-stack">
      {state.rows.map(({ filing, sentiment }) => (
        <section key={filing.accessNumber} className="hm-sentiment-card">
          <div className="hm-sentiment-card__head">
            <strong>{filing.form || 'Filing'}</strong>
            <span>{formatFilingDate(filing.filedDate || filing.acceptedDate)}</span>
          </div>
          <div className="hm-sentiment-grid">
            {SENTIMENT_FIELDS.map(field => {
              const value = sentimentValue(sentiment, field.key)
              return (
                <div key={`${filing.accessNumber}-${field.key}`} className="hm-sentiment-metric">
                  <span className="hm-sentiment-metric__label">{field.label}</span>
                  <span className={`hm-sentiment-metric__value hm-sentiment-metric__value--${field.tone || 'neutral'}`}>
                    {formatSentimentMetric(value, field.format || 'share')}
                  </span>
                </div>
              )
            })}
          </div>
        </section>
      ))}
      <p className="hm-panel-footnote">
        Word-share percentages from Loughran-McDonald lists; polarity is a signed score, not a percent.
      </p>
    </div>
  )
}
