import { formatApiError } from './apiError'
import { tickerSymbol } from './screenerDefinition'

const API = '/api/yahoo-finance'

export const YAHOO_EXTENDED_HOURS_KEY = 'dashboard-yahoo-extended-hours'
export const YAHOO_QUOTE_STAGGER_MS = 400

export type YahooQuoteSession = 'PRE' | 'REG' | 'POST' | 'CLOSED' | string

export type YahooExtendedQuote = {
  ticker: string
  yahoo_symbol: string
  session: YahooQuoteSession
  extended_hours: boolean
  previous_close: number | null
  price: number | null
  change: number | null
  change_pct: number | null
  direction: 'up' | 'down' | 'flat' | string
  high: number | null
  low: number | null
  currency?: string | null
  exchange_timezone?: string | null
  market_state?: string | null
  interval?: string
  range?: string
  stale?: boolean
}

export function loadYahooExtendedHoursEnabled(): boolean {
  try {
    return localStorage.getItem(YAHOO_EXTENDED_HOURS_KEY) === '1'
  } catch {
    return false
  }
}

export function saveYahooExtendedHoursEnabled(enabled: boolean) {
  try {
    localStorage.setItem(YAHOO_EXTENDED_HOURS_KEY, enabled ? '1' : '0')
  } catch {
    // ignore
  }
}

export function yahooQuoteKey(ticker: string): string {
  return tickerSymbol(ticker).toUpperCase()
}

const clientCache = new Map<string, { at: number; quote: YahooExtendedQuote }>()
const inflightByKey = new Map<string, Promise<YahooExtendedQuote>>()
const CLIENT_CACHE_MS = 90_000

export async function fetchYahooExtendedQuote(ticker: string): Promise<YahooExtendedQuote> {
  const symbol = tickerSymbol(ticker)
  if (!symbol) throw new Error('Ticker is required')
  const key = symbol.toUpperCase()
  const cached = clientCache.get(key)
  if (cached && Date.now() - cached.at < CLIENT_CACHE_MS) {
    return cached.quote
  }

  const inflight = inflightByKey.get(key)
  if (inflight) {
    return inflight
  }

  const promise = (async () => {
    const res = await fetch(`${API}/quote?ticker=${encodeURIComponent(symbol)}`)
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      if (!res.ok) throw new Error(res.statusText || 'Yahoo Finance request failed')
      throw new Error('Invalid response from server')
    }
    const payload = body as { status?: boolean; data?: YahooExtendedQuote; detail?: unknown }
    if (res.status === 429) {
      throw new Error(formatApiError(body, 'Yahoo Finance rate limited — retrying'))
    }
    if (!res.ok || payload.status === false) {
      throw new Error(formatApiError(body, res.statusText || 'Yahoo Finance request failed'))
    }
    const quote = payload.data as YahooExtendedQuote
    clientCache.set(key, { at: Date.now(), quote })
    return quote
  })()

  inflightByKey.set(key, promise)
  try {
    return await promise
  } finally {
    if (inflightByKey.get(key) === promise) {
      inflightByKey.delete(key)
    }
  }
}

export function yahooQuoteMetrics(quote: YahooExtendedQuote): {
  pct: number | null
  price: number | null
  changeAbs: number | null
} {
  return {
    pct: quote.change_pct,
    price: quote.price,
    changeAbs: quote.change,
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms))
}
