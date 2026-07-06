import type { RefObject } from 'react'

import type { AgentThreadFocus } from './agentThreads'
import { CLIENT_MONITOR_WINDOW_MS } from './agentClientMonitorCache'
import { fetchCompanyNews } from './companyNews'
import { loadExecutionPositions } from './executionPositions'
import type { HomeIndexSymbol } from './homeIndices'
import { fetchMarketNews } from './marketNews'
import type { LinkedExecution } from '@/hooks/useAgentThreadExecutions'
import {
  fetchEtoroOrders,
  fetchEtoroPositions,
  flattenEtoroOrders,
} from './etoro-account-data'
import { fetchPortfolio } from './portfolio-cache'
import {
  percentChangeFromHistory,
  type PriceSample,
} from './watchlistChangeColumns'
import { findWatchlistFeedMatch } from './watchlistFeedReuse'
import type { Watchlist } from './watchlists'

export type ClientMonitorContext = {
  collected_at: string
  window_minutes: number
  symbol: string
  focus: Record<string, unknown>
  /** All symbols being watched in compare / multi-candidate mode */
  candidates: Array<{
    symbol: string
    token?: string | null
    price: {
      ltp: number | null
      move_pct: number | null
      high: number | null
      low: number | null
      samples: Array<{ ts: number; ltp: number }>
    }
  }>
  price: {
    ltp: number | null
    move_pct: number | null
    high: number | null
    low: number | null
    samples: Array<{ ts: number; ltp: number }>
  }
  indices: Array<{
    id: string
    label: string
    ltp: number | null
    change_10m: number | null
  }>
  news: Array<{ headline: string; source?: string; datetime?: number; url?: string }>
  market_headlines: Array<{ headline: string; source?: string; datetime?: number; url?: string }>
  positions: Array<Record<string, unknown>>
  /** Always populated for eToro threads — portfolio, positions, and orders */
  etoro_account?: {
    account_env: string
    portfolio: Array<Record<string, unknown>>
    positions: Array<Record<string, unknown>>
    orders: Array<Record<string, unknown>>
  }
}

type WatchTargetInput = {
  focus: AgentThreadFocus
  ltp: number | null
  dedicatedSamples?: PriceSample[]
}

type BuildParams = {
  focus: AgentThreadFocus
  ltp: number | null
  watchTargets?: WatchTargetInput[]
  watchlists: Watchlist[]
  ticks: Record<string, { ltp?: number | null }>
  historyRef: RefObject<Record<string, PriceSample[]>> | Record<string, PriceSample[]>
  indices: HomeIndexSymbol[]
  indexLtps: Record<string, number | null>
  executions: LinkedExecution[]
  windowMinutes?: number
  dedicatedSamples?: PriceSample[]
  now?: number
}

function historyMap(
  historyRef: RefObject<Record<string, PriceSample[]>> | Record<string, PriceSample[]>,
): Record<string, PriceSample[]> {
  return 'current' in historyRef ? historyRef.current : historyRef
}

function filterRecentUnix(items: Array<{ datetime?: number | null }>, cutoffSec: number) {
  return items.filter(item => (item.datetime || 0) >= cutoffSec)
}

function priceWindow(samples: PriceSample[], now: number, ltp: number | null, windowMs: number) {
  const cutoff = now - windowMs
  const windowSamples = samples.filter(sample => sample.ts >= cutoff)
  const prices = windowSamples.map(sample => sample.ltp).filter(value => Number.isFinite(value) && value > 0)
  const current = ltp ?? prices[prices.length - 1] ?? null
  const high = prices.length ? Math.max(...prices) : current
  const low = prices.length ? Math.min(...prices) : current
  const movePct = percentChangeFromHistory(samples, current ?? 0, windowMs, now)
  return {
    ltp: current,
    move_pct: movePct,
    high: high ?? null,
    low: low ?? null,
    samples: windowSamples.slice(-120).map(sample => ({ ts: sample.ts, ltp: sample.ltp })),
  }
}

async function fetchRecentNewsNotifications(): Promise<
  Array<{ headline: string; source?: string | null; datetime?: number | null; url?: string | null; scope?: string; topic?: string }>
> {
  const res = await fetch('/api/market/news-notifications?limit=100')
  if (!res.ok) return []
  const payload = (await res.json()) as { data?: Array<Record<string, unknown>> }
  if (!Array.isArray(payload.data)) return []
  return payload.data.map(row => ({
    headline: String(row.headline || ''),
    source: row.source ? String(row.source) : undefined,
    datetime: typeof row.datetime === 'number' ? row.datetime : null,
    url: row.url ? String(row.url) : undefined,
    scope: row.scope ? String(row.scope) : undefined,
    topic: row.topic ? String(row.topic) : undefined,
  }))
}

export async function buildAgentClientMonitorContext({
  focus,
  ltp,
  watchTargets = [],
  watchlists,
  ticks,
  historyRef,
  indices,
  indexLtps,
  executions,
  windowMinutes,
  dedicatedSamples = [],
  now = Date.now(),
}: BuildParams): Promise<ClientMonitorContext> {
  const symbol = String(focus.symbol || '').trim()
  const windowMs = (windowMinutes ?? CLIENT_MONITOR_WINDOW_MS / 60_000) * 60_000
  const cutoffSec = Math.floor(now / 1000) - windowMs / 1000

  const targets: WatchTargetInput[] = watchTargets.length
    ? watchTargets
    : [{ focus, ltp, dedicatedSamples }]

  const candidateRows = targets.map(target => {
    const targetSymbol = String(target.focus.symbol || '').trim()
    const feedMatch = findWatchlistFeedMatch(watchlists, ticks, historyRef, {
      broker: target.focus.broker,
      account_env: target.focus.account_env,
      token: target.focus.token,
      symbol: targetSymbol,
    })
    const watchlistSamples = feedMatch?.samples ?? []
    const samples = watchlistSamples.length
      ? watchlistSamples
      : (target.dedicatedSamples ?? [])
    const effectiveLtp =
      target.ltp
      ?? feedMatch?.tick?.ltp
      ?? samples[samples.length - 1]?.ltp
      ?? null
    return {
      symbol: targetSymbol,
      token: target.focus.token ?? null,
      price: priceWindow(samples, now, effectiveLtp, windowMs),
    }
  })

  const primaryRow = candidateRows.find(row => row.symbol.toUpperCase() === symbol.toUpperCase())
    || candidateRows[0]
    || {
      symbol,
      token: focus.token ?? null,
      price: priceWindow(dedicatedSamples, now, ltp, windowMs),
    }

  const feedMatch = findWatchlistFeedMatch(watchlists, ticks, historyRef, {
    broker: focus.broker,
    account_env: focus.account_env,
    token: focus.token,
    symbol,
  })
  const watchlistSamples = feedMatch?.samples ?? []
  const samples = watchlistSamples.length ? watchlistSamples : dedicatedSamples
  const effectiveLtp =
    ltp
    ?? feedMatch?.tick?.ltp
    ?? dedicatedSamples[dedicatedSamples.length - 1]?.ltp
    ?? primaryRow.price.ltp
    ?? null

  const history = historyMap(historyRef)
  const indexRows = indices.map(index => {
    const indexSamples = history[index.tickKey] ?? []
    const indexLtp = indexLtps[index.id] ?? null
    const change10m = percentChangeFromHistory(
      indexSamples,
      indexLtp ?? 0,
      windowMs,
      now,
    )
    return {
      id: index.id,
      label: index.label,
      ltp: indexLtp,
      change_10m: change10m,
    }
  })

  const accountEnvName = String(focus.account_env || 'demo').toLowerCase()

  const [companyNewsGroups, marketNews, liveNews, positionGroups, etoroAccount] = await Promise.all([
    Promise.all(
      candidateRows
        .map(row => row.symbol)
        .filter((value, index, array) => value && array.indexOf(value) === index)
        .map(sym => fetchCompanyNews(sym, 1).catch(() => [])),
    ),
    fetchMarketNews('general', 0).catch(() => []),
    fetchRecentNewsNotifications().catch(() => []),
    Promise.all(
      executions.map(async execution => {
        const rows = await loadExecutionPositions({
          executorId: execution.executionId,
          broker: execution.broker || focus.broker,
          accountEnv: execution.accountEnv || focus.account_env,
          symbol: execution.symbol || symbol,
          token: focus.token,
        }).catch(() => [])
        return rows.map(row => ({
          execution_id: execution.executionId,
          symbol: execution.symbol || symbol,
          position_id: row.position_id,
          state: row.state,
          remaining_units: row.remaining_units,
          source: row.source,
          status_label: row.statusLabel,
        }))
      }),
    ),
    (async () => {
      const env = accountEnvName === 'live' ? 'live' : 'demo'
      const [portfolioRes, positionsRes, ordersRes] = await Promise.all([
        fetchPortfolio('etoro', env, { refresh: true }).catch(() => ({ status: false, data: [] })),
        fetchEtoroPositions(env, { refresh: true }).catch(() => ({ status: false, data: [] })),
        fetchEtoroOrders(env).catch(() => ({ status: false, data: undefined })),
      ])
      return {
        account_env: env,
        portfolio: Array.isArray(portfolioRes.data) ? portfolioRes.data : [],
        positions: Array.isArray(positionsRes.data) ? positionsRes.data : [],
        orders: flattenEtoroOrders(ordersRes.data),
      }
    })(),
  ])

  const symbolUpperSet = new Set(
    candidateRows.map(row => row.symbol.toUpperCase()).filter(Boolean),
  )
  if (symbol) symbolUpperSet.add(symbol.toUpperCase())

  const companyNews = companyNewsGroups.flat()
  const scopedLiveNews = liveNews.filter(item => {
    if (item.scope === 'market') return true
    if (item.topic && symbolUpperSet.has(item.topic.toUpperCase())) return true
    return false
  })

  const news = [
    ...filterRecentUnix(companyNews, cutoffSec).map(item => ({
      headline: item.headline,
      source: item.source,
      datetime: item.datetime,
      url: item.url,
    })),
    ...scopedLiveNews
      .filter(item => (item.datetime || 0) >= cutoffSec)
      .map(item => ({
        headline: item.headline,
        source: item.source || undefined,
        datetime: item.datetime || undefined,
        url: item.url || undefined,
      })),
  ]

  const marketHeadlines = filterRecentUnix(marketNews, cutoffSec).map(item => ({
    headline: item.headline,
    source: item.source,
    datetime: item.datetime,
    url: item.url,
  }))

  return {
    collected_at: new Date(now).toISOString(),
    window_minutes: windowMs / 60_000,
    symbol: primaryRow.symbol || symbol,
    focus: { ...focus, symbol: primaryRow.symbol || symbol },
    candidates: candidateRows,
    price: primaryRow.price.ltp != null
      ? primaryRow.price
      : priceWindow(samples, now, effectiveLtp, windowMs),
    indices: indexRows,
    news,
    market_headlines: marketHeadlines,
    positions: positionGroups.flat(),
    etoro_account: etoroAccount,
  }
}
