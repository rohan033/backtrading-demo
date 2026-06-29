import { useEffect, useMemo, useState } from 'react'
import {
  fetchEarningsCalendar,
  fetchFilingSentiment,
  fetchSecFilings,
  finnhubSymbol,
  formatCompactMoney,
  formatEarningsHour,
  formatFilingDate,
  formatPct,
  type EarningsEvent,
  type FilingSentiment,
  type SecFiling,
} from '../../lib/marketResearch'

function PanelMessage({ children }: { children: React.ReactNode }) {
  return <p className="hm-panel-message">{children}</p>
}

function PanelError({ message }: { message: string }) {
  return <p className="hm-panel-message hm-panel-message--error">{message}</p>
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
    <ul className="hm-data-list">
      {items.map(item => (
        <li key={item.accessNumber} className="hm-data-row">
          <div className="hm-data-row__head">
            <span className="hm-data-row__badge">{item.form || 'SEC'}</span>
            <span className="hm-data-row__date">{formatFilingDate(item.filedDate || item.acceptedDate)}</span>
          </div>
          <div className="hm-data-row__meta">{item.accessNumber}</div>
          <div className="hm-data-row__links">
            {item.reportUrl ? (
              <a href={item.reportUrl} target="_blank" rel="noopener noreferrer">Report</a>
            ) : null}
            {item.filingUrl ? (
              <a href={item.filingUrl} target="_blank" rel="noopener noreferrer">Filing index</a>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
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

  if (loading) return <PanelMessage>Loading earnings calendar…</PanelMessage>
  if (error) return <PanelError message={error} />
  if (!items.length) {
    return (
      <PanelMessage>
        No earnings events found for {finnhubSymbol(symbol)} in the selected window.
      </PanelMessage>
    )
  }

  return (
    <div className="hm-earnings-table-wrap">
      <table className="hm-earnings-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>EPS</th>
            <th>Rev</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {items.map(item => {
            const key = `${item.date}-${item.quarter}-${item.year}-${item.hour}`
            const epsActual = item.epsActual
            const epsEstimate = item.epsEstimate
            const beat = epsActual != null && epsEstimate != null && epsActual >= epsEstimate
            return (
              <tr key={key}>
                <td>
                  <div className="hm-earnings-date">{item.date || '—'}</div>
                  <div className="hm-earnings-q">
                    {item.quarter ? `Q${item.quarter}` : '—'}
                    {item.year ? ` ${item.year}` : ''}
                  </div>
                </td>
                <td>
                  <div className={`hm-earnings-val${beat ? ' hm-earnings-val--up' : ''}`}>
                    {epsActual != null ? epsActual.toFixed(2) : '—'}
                  </div>
                  <div className="hm-earnings-sub">
                    est {epsEstimate != null ? epsEstimate.toFixed(2) : '—'}
                  </div>
                </td>
                <td>
                  <div className="hm-earnings-val">{formatCompactMoney(item.revenueActual)}</div>
                  <div className="hm-earnings-sub">
                    est {formatCompactMoney(item.revenueEstimate)}
                  </div>
                </td>
                <td>{formatEarningsHour(item.hour)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const SENTIMENT_FIELDS: Array<{ key: keyof FilingSentiment | string; label: string; tone?: 'pos' | 'neg' | 'neutral' }> = [
  { key: 'positive', label: 'Positive', tone: 'pos' },
  { key: 'negative', label: 'Negative', tone: 'neg' },
  { key: 'polarity', label: 'Polarity', tone: 'neutral' },
  { key: 'uncertainty', label: 'Uncertainty', tone: 'neutral' },
  { key: 'litigious', label: 'Litigious', tone: 'neg' },
  { key: 'constraining', label: 'Constraining', tone: 'neutral' },
  { key: 'modal-weak', label: 'Modal weak', tone: 'neutral' },
  { key: 'modal-moderate', label: 'Modal moderate', tone: 'neutral' },
  { key: 'modal-strong', label: 'Modal strong', tone: 'neutral' },
]

function sentimentValue(row: FilingSentiment, key: string): number | null {
  if (key in row && typeof row[key as keyof FilingSentiment] === 'number') {
    return row[key as keyof FilingSentiment] as number
  }
  const nested = row.sentiment?.[key]
  return typeof nested === 'number' ? nested : null
}

export function HomeSentimentPanel({ symbol }: { symbol: string }) {
  const [rows, setRows] = useState<Array<{ filing: SecFiling; sentiment: FilingSentiment }>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setRows([])

    ;(async () => {
      try {
        const filings = await fetchSecFilings(symbol, { days: 730, limit: 80 })
        const targets = filings
          .filter(item => ['10-K', '10-Q'].includes(String(item.form || '').toUpperCase()))
          .slice(0, 3)
        if (!targets.length) {
          if (!cancelled) setRows([])
          return
        }

        const loaded: Array<{ filing: SecFiling; sentiment: FilingSentiment }> = []
        for (const filing of targets) {
          if (!filing.accessNumber) continue
          try {
            const sentiment = await fetchFilingSentiment(filing.accessNumber)
            loaded.push({ filing, sentiment })
          } catch {
            // Premium endpoint may fail per filing; keep others.
          }
        }
        if (!cancelled) setRows(loaded)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load filing sentiment')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [symbol])

  const headline = useMemo(
    () => (rows.length ? `Latest ${rows[0].filing.form} sentiment` : ''),
    [rows],
  )

  if (loading) return <PanelMessage>Loading filing sentiment…</PanelMessage>
  if (error) return <PanelError message={error} />
  if (!rows.length) {
    return (
      <PanelMessage>
        No 10-K / 10-Q filing sentiment available for {finnhubSymbol(symbol)}. This Finnhub endpoint requires premium access.
      </PanelMessage>
    )
  }

  return (
    <div className="hm-sentiment-stack">
      {rows.map(({ filing, sentiment }) => (
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
                    {formatPct(value, 2)}
                  </span>
                </div>
              )
            })}
          </div>
        </section>
      ))}
      {headline ? <p className="hm-panel-footnote">{headline} uses Loughran-McDonald word lists.</p> : null}
    </div>
  )
}
