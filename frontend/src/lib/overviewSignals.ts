import { detectChartOpportunity, type ChartOpportunitySignal } from './chartOpportunityDetector'
import type { HaltDirection } from './overviewHaltDirection'
import type { Screener, ScreenerResultRow } from './screenerApi'
import { homeMoverMetrics } from './homeMarketMovers'
import { tickerSymbol } from './screenerDefinition'
import type { WatchlistSanitizedCandle } from './watchlistCandles'

export type OverviewTradeSignal = {
  symbol: string
  score: number
  urgency: 'high' | 'medium' | 'low'
  reasons: string[]
  sources: Array<'screener' | 'halt' | 'chart'>
  screenerName?: string
  changePct?: number | null
  haltDirection?: HaltDirection
  chartSignal?: ChartOpportunitySignal
  rank?: number
}

export type OverviewScreenerPick = {
  symbol: string
  screenerName: string
  sourceType?: Screener['source_type']
  row: ScreenerResultRow
  changePct: number | null
}

const TOP_PER_SCREENER = 10
const MAX_SIGNALS = 12

function parseRank(row: ScreenerResultRow): number {
  const rank = Number(row.rank ?? row.position)
  return Number.isFinite(rank) ? rank : 999
}

export function collectTopScreenerPicks(screeners: Screener[]): OverviewScreenerPick[] {
  const picks: OverviewScreenerPick[] = []
  const seen = new Set<string>()

  for (const screener of screeners) {
    const rows = [...(screener.results || [])]
      .sort((a, b) => parseRank(a) - parseRank(b))
      .slice(0, TOP_PER_SCREENER)

    for (const row of rows) {
      const symbol = tickerSymbol(row.ticker).toUpperCase()
      if (!symbol || seen.has(symbol)) continue
      seen.add(symbol)
      const metrics = homeMoverMetrics(row, screener.source_type)
      picks.push({
        symbol,
        screenerName: screener.name,
        sourceType: screener.source_type,
        row,
        changePct: metrics.pct,
      })
    }
  }
  return picks
}

export function buildOverviewTradeSignals(args: {
  screeners: Screener[]
  haltedSymbols: Array<{ symbol: string; direction: HaltDirection; changePct: number | null }>
  candlesBySymbol: Record<string, WatchlistSanitizedCandle[]>
}): OverviewTradeSignal[] {
  const picks = collectTopScreenerPicks(args.screeners)
  const haltBySymbol = new Map(args.haltedSymbols.map(item => [item.symbol.toUpperCase(), item]))
  const signals: OverviewTradeSignal[] = []

  for (const pick of picks) {
    const changePct = pick.changePct
    if (changePct == null || changePct <= 0) continue

    const candles = args.candlesBySymbol[pick.symbol] || []
    const chart = candles.length >= 20
      ? detectChartOpportunity(candles, { lookbackMinutes: 30, minScore: 58 })
      : null

    let score = 40 + Math.min(25, changePct * 2)
    const reasons: string[] = [`${pick.screenerName}: +${changePct.toFixed(2)}%`]
    const sources: OverviewTradeSignal['sources'] = ['screener']

    if (parseRank(pick.row) <= 3) {
      score += 8
      reasons.push('Top-3 screener rank')
    }

    const halt = haltBySymbol.get(pick.symbol)
    if (halt) {
      sources.push('halt')
      if (halt.direction === 'uphalt') {
        score += 18
        reasons.push('Uphalt — momentum continuation')
      } else if (halt.direction === 'downhalt') {
        score -= 15
        reasons.push('Downhalt — avoid chasing long')
      }
    }

    if (chart && chart.direction === 'long') {
      sources.push('chart')
      score += chart.score * 0.35
      reasons.push(...chart.reasons.slice(0, 2))
    } else if (chart && chart.direction === 'short') {
      score -= 10
    }

    if (score < 55) continue

    signals.push({
      symbol: pick.symbol,
      score: Math.round(Math.min(100, score)),
      urgency: score >= 82 ? 'high' : score >= 68 ? 'medium' : 'low',
      reasons,
      sources,
      screenerName: pick.screenerName,
      changePct,
      haltDirection: halt?.direction,
      chartSignal: chart ?? undefined,
      rank: parseRank(pick.row),
    })
  }

  for (const halt of args.haltedSymbols) {
    if (halt.direction !== 'uphalt') continue
    if (signals.some(item => item.symbol === halt.symbol)) continue

    const candles = args.candlesBySymbol[halt.symbol] || []
    const chart = candles.length >= 20
      ? detectChartOpportunity(candles, { lookbackMinutes: 30, minScore: 55 })
      : null

    let score = 62
    const reasons = ['Uphalt — resume momentum play']
    const sources: OverviewTradeSignal['sources'] = ['halt']
    if (halt.changePct != null) {
      reasons.push(`Pre-halt +${halt.changePct.toFixed(2)}% (5m window)`)
      score += Math.min(12, halt.changePct)
    }
    if (chart && chart.direction === 'long') {
      sources.push('chart')
      score += chart.score * 0.3
      reasons.push(...chart.reasons.slice(0, 2))
    }

    signals.push({
      symbol: halt.symbol,
      score: Math.round(Math.min(100, score)),
      urgency: score >= 80 ? 'high' : 'medium',
      reasons,
      sources,
      haltDirection: halt.direction,
      chartSignal: chart ?? undefined,
    })
  }

  return signals
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SIGNALS)
}
