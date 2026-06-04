import { useEffect, useState } from 'react'

import { fetchPortfolio } from '../lib/portfolio-cache'

export type AccountSummaryData = {
  equity: number
  angelEquity: number
  etoroEquity: number
  dayPnl: number
  buyingPower: number
  positions: number
  runningStrategies: number
}

export type PortfolioHolding = {
  symbol: string
  ltp: number
  quantity: number
  changePct?: number
  broker?: string
}

const DEFAULT_SUMMARY: AccountSummaryData = {
  equity: 0,
  angelEquity: 0,
  etoroEquity: 0,
  dayPnl: 0,
  buyingPower: 0,
  positions: 0,
  runningStrategies: 0,
}

function equityFromRows(rows: Array<Record<string, unknown>>) {
  return rows.reduce(
    (sum, row) => sum + (Number(row.quantity) || 0) * (Number(row.ltp) || 0),
    0,
  )
}

function holdingsFromRows(rows: Array<Record<string, unknown>>): PortfolioHolding[] {
  return rows.slice(0, 8).map(row => ({
    symbol: String(row.symbol || row.tradingsymbol || '—'),
    ltp: Number(row.ltp) || 0,
    quantity: Number(row.quantity) || 0,
    changePct: Number(row.pnl_pct) || undefined,
    broker: String(row.broker || ''),
  }))
}

function summaryFromHoldings(
  angelHoldings: Array<Record<string, unknown>>,
  etoroHoldings: Array<Record<string, unknown>>,
  runningStrategies: number,
): AccountSummaryData {
  const angelEquity = equityFromRows(angelHoldings)
  const etoroEquity = equityFromRows(etoroHoldings)
  const positions = angelHoldings.length + etoroHoldings.length
  return {
    angelEquity,
    etoroEquity,
    equity: angelEquity + etoroEquity,
    dayPnl: 0,
    buyingPower: angelEquity,
    positions,
    runningStrategies,
  }
}

export function useAccountSummary() {
  const [summary, setSummary] = useState<AccountSummaryData>(DEFAULT_SUMMARY)
  const [holdings, setHoldings] = useState<PortfolioHolding[]>([])

  useEffect(() => {
    let cancelled = false

    async function loadPortfolioSummary() {
      try {
        const [angelData, etoroData] = await Promise.all([
          fetchPortfolio('angel', 'live'),
          fetchPortfolio('etoro', 'demo'),
        ])
        const angelHoldings = angelData.status ? angelData.data || [] : []
        const etoroHoldings = etoroData.status ? etoroData.data || [] : []
        const allHoldings = [...angelHoldings, ...etoroHoldings]

        if (!cancelled) {
          setHoldings(holdingsFromRows(allHoldings))
          setSummary(prev => ({
            ...summaryFromHoldings(angelHoldings, etoroHoldings, prev.runningStrategies),
          }))
        }
      } catch {
        if (!cancelled) {
          setHoldings([])
        }
      }
    }

    async function loadRunningStrategies() {
      try {
        const enginesRes = await fetch('/api/control/engines')
        const enginesData = await enginesRes.json()
        const runningStrategies = enginesData.status
          ? (enginesData.data || []).filter(
              (engine: { status?: string }) =>
                engine.status === 'running' || engine.status === 'starting',
            ).length
          : 0

        if (!cancelled) {
          setSummary(prev => ({ ...prev, runningStrategies }))
        }
      } catch {
        if (!cancelled) {
          setSummary(prev => ({ ...prev, runningStrategies: 0 }))
        }
      }
    }

    loadPortfolioSummary()
    loadRunningStrategies()

    const enginesIntervalId = setInterval(loadRunningStrategies, 30000)
    return () => {
      cancelled = true
      clearInterval(enginesIntervalId)
    }
  }, [])

  return { summary, holdings }
}

export function pnlClass(value: number) {
  if (value > 0) return 'text-green'
  if (value < 0) return 'text-red'
  return 'text-text-primary'
}

export { formatInr, formatSignedInr, formatUsd, formatSignedUsd } from '../lib/currency'
