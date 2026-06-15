import type { RefObject } from 'react'

import { defaultAccountEnv, type WatchlistBroker } from './watchlistBrokers'
import type { PriceSample } from './watchlistChangeColumns'
import { watchlistTickKey, type Watchlist, type WatchlistTick } from './watchlists'

export type WatchlistFeedMatch = {
  tickKey: string
  tick: WatchlistTick | null
  samples: PriceSample[]
}

export type WatchlistFeedLookup = {
  broker: string
  account_env?: string | null
  token?: string | number | null
  symbol?: string | null
}

function normalizeBroker(broker?: string | null): WatchlistBroker {
  return (broker || 'angel').toLowerCase() === 'etoro' ? 'etoro' : 'angel'
}

function symbolName(value: string | null | undefined): string {
  return String(value || '').trim().toUpperCase()
}

/** Resolves the watchlist row for an execution symbol (token or tradingsymbol). */
export function resolveWatchlistSymbolRef(
  watchlists: Watchlist[],
  params: WatchlistFeedLookup,
): { broker: WatchlistBroker; accountEnv: string; symboltoken: string } | null {
  const token = String(params.token || '').trim()
  const targetSymbol = symbolName(params.symbol)
  const broker = normalizeBroker(params.broker)
  const accountEnv = params.account_env || defaultAccountEnv(broker)

  for (const watchlist of watchlists) {
    const wlBroker = normalizeBroker(watchlist.broker)
    const wlEnv = watchlist.account_env || defaultAccountEnv(wlBroker)
    if (wlBroker !== broker || wlEnv !== accountEnv) continue

    for (const symbol of watchlist.symbols) {
      const matchesToken = Boolean(token) && symbol.symboltoken === token
      const matchesName =
        Boolean(targetSymbol)
        && (symbolName(symbol.tradingsymbol) === targetSymbol
          || symbolName(symbol.symbol) === targetSymbol)
      if (matchesToken || matchesName) {
        return { broker: wlBroker, accountEnv: wlEnv, symboltoken: symbol.symboltoken }
      }
    }
  }
  return null
}

/** True when the symbol is on a watchlist with matching broker/env (feed may be active). */
export function isSymbolOnWatchlistFeed(
  watchlists: Watchlist[],
  params: WatchlistFeedLookup,
): boolean {
  return resolveWatchlistSymbolRef(watchlists, params) != null
}

export function findWatchlistFeedMatch(
  watchlists: Watchlist[],
  ticks: Record<string, WatchlistTick>,
  historyRef: RefObject<Record<string, PriceSample[]>> | Record<string, PriceSample[]>,
  params: WatchlistFeedLookup,
): WatchlistFeedMatch | null {
  const resolved = resolveWatchlistSymbolRef(watchlists, params)
  if (!resolved) return null

  const tickKey = watchlistTickKey(resolved.broker, resolved.accountEnv, resolved.symboltoken)
  const history =
    'current' in historyRef ? historyRef.current : historyRef
  return {
    tickKey,
    tick: ticks[tickKey] ?? null,
    samples: history?.[tickKey] ?? [],
  }
}

export type PriceStreamStatus = {
  status: string
  label: string
  detail?: string
  tone: 'muted' | 'warn' | 'ok' | 'error'
  lastTickAgeSec?: number | null
}

/** Overrides a stale/empty execution-plane status when the watchlist feed has live ticks. */
export function applyWatchlistFeedToStreamStatus(
  planeStatus: PriceStreamStatus,
  watchlistFeed: WatchlistFeedMatch | null,
): PriceStreamStatus {
  if (!watchlistFeed?.tick?.ltp) return planeStatus
  if (!['no_ticks', 'stale', 'waiting', 'connecting', 'offline', 'disconnected'].includes(planeStatus.status)) {
    return planeStatus
  }
  return {
    ...planeStatus,
    status: 'flowing',
    label: 'Live (watchlist feed)',
    detail: 'Reusing the shared watchlist WebSocket feed.',
    tone: 'ok',
    lastTickAgeSec: 0,
  }
}

export function samplesToChartPoints(samples: PriceSample[]): Array<{ time: number; value: number }> {
  const points = samples
    .filter(sample => Number.isFinite(sample.ltp) && sample.ltp > 0)
    .map(sample => ({
      time: Math.floor(sample.ts / 1000),
      value: sample.ltp,
    }))
    .sort((a, b) => a.time - b.time)

  const deduped: Array<{ time: number; value: number }> = []
  for (const point of points) {
    const last = deduped[deduped.length - 1]
    if (last?.time === point.time) deduped[deduped.length - 1] = point
    else deduped.push(point)
  }
  return deduped
}

/** Line chart points — skip flat runs so an unchanged price is a dot, not a long horizontal line. */
export function buildWatchlistLinePoints(
  samples: PriceSample[],
  liveLtp?: number | null,
): Array<{ time: number; value: number }> {
  const points = samplesToChartPoints(samples)

  if (!points.length) {
    const price = Number(liveLtp)
    if (!Number.isFinite(price) || price <= 0) return []
    return [{ time: Math.floor(Date.now() / 1000), value: price }]
  }

  if (points.every(point => point.value === points[0].value)) {
    return [points[points.length - 1]]
  }

  const result = [points[0]]
  for (let i = 1; i < points.length; i++) {
    const point = points[i]
    if (point.value !== result[result.length - 1].value) {
      result.push(point)
    }
  }
  return result
}

export type WatchlistCandle = {
  time: number
  open: number
  high: number
  low: number
  close: number
}

/** Aggregate tick samples into 1-minute candles for watchlist chart view. */
export function samplesToCandles(samples: PriceSample[]): WatchlistCandle[] {
  const buckets = new Map<number, WatchlistCandle>()
  for (const sample of samples) {
    if (!Number.isFinite(sample.ltp) || sample.ltp <= 0) continue
    const time = Math.floor(sample.ts / 60_000) * 60
    const existing = buckets.get(time)
    if (!existing) {
      buckets.set(time, {
        time,
        open: sample.ltp,
        high: sample.ltp,
        low: sample.ltp,
        close: sample.ltp,
      })
      continue
    }
    existing.high = Math.max(existing.high, sample.ltp)
    existing.low = Math.min(existing.low, sample.ltp)
    existing.close = sample.ltp
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time)
}

export function shouldReuseWatchlistFeed(
  watchlists: Watchlist[],
  connected: boolean,
  params: WatchlistFeedLookup,
): boolean {
  return connected && isSymbolOnWatchlistFeed(watchlists, params)
}
