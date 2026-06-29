export type SecFiling = {
  accessNumber: string
  symbol?: string
  cik?: string
  form?: string
  filedDate?: string
  acceptedDate?: string
  reportUrl?: string
  filingUrl?: string
}

export type FilingSentiment = {
  accessNumber?: string
  symbol?: string
  cik?: string
  sentiment?: Record<string, number>
  positive?: number
  negative?: number
  polarity?: number
  uncertainty?: number
  litigious?: number
  constraining?: number
  'modal-weak'?: number
  'modal-moderate'?: number
  'modal-strong'?: number
}

export type EarningsEvent = {
  date?: string
  symbol?: string
  epsActual?: number | null
  epsEstimate?: number | null
  revenueActual?: number | null
  revenueEstimate?: number | null
  hour?: string
  quarter?: number
  year?: number
}

export type WatchlistEarningsRef = {
  tradingsymbol?: string
  symboltoken?: string
  watchlistId?: string
  broker?: string
  accountEnv?: string
}

export type WatchlistEarningsEvent = EarningsEvent & {
  finnhubSymbol?: string
  watchlistRefs?: WatchlistEarningsRef[]
}

export type EarningsMonitorAlert = {
  id: string
  symbol: string
  phase: 'post_earnings' | 'earnings_today' | string
  earningsDate: string
  quarter?: number
  year?: number
  hour?: string
  watchlistRefs?: WatchlistEarningsRef[]
  message: string
}

export type WatchlistEarningsResponse = {
  status?: boolean
  data?: WatchlistEarningsEvent[]
  monitor?: EarningsMonitorAlert[]
  meta?: {
    tickerCount?: number
    eventCount?: number
    pastDays?: number
    futureDays?: number
    errors?: Array<{ symbol?: string; status?: number; detail?: string }>
  }
}

export type InsiderTransaction = {
  id?: string
  symbol?: string
  finnhubSymbol?: string
  name?: string
  change?: number | null
  share?: number | null
  filingDate?: string
  transactionDate?: string
  transactionCode?: string
  transactionPrice?: number | null
  watchlistRefs?: WatchlistEarningsRef[]
}

export type WatchlistInsiderResponse = {
  status?: boolean
  data?: InsiderTransaction[]
  meta?: {
    tickerCount?: number
    transactionCount?: number
    days?: number
    lastPolledAt?: string | null
    cached?: boolean
    ageSeconds?: number
  }
}

type ApiListResponse<T> = {
  status?: boolean
  data?: T[]
  meta?: Record<string, unknown>
  detail?: string
}

type ApiObjectResponse<T> = {
  status?: boolean
  data?: T
  meta?: Record<string, unknown>
  detail?: string
}

async function parseJson<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as T & { detail?: string }
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error('Research API not found — restart the control plane (make dev or make cp-reload).')
    }
    throw new Error(body?.detail || res.statusText || `Request failed (${res.status})`)
  }
  return body
}

export async function fetchSecFilings(
  symbol: string,
  options?: { form?: string; days?: number; limit?: number },
): Promise<SecFiling[]> {
  const params = new URLSearchParams({ symbol: symbol.trim() })
  if (options?.form) params.set('form', options.form)
  if (options?.days) params.set('days', String(options.days))
  if (options?.limit) params.set('limit', String(options.limit))
  const res = await fetch(`/api/market/filings?${params.toString()}`)
  const payload = await parseJson<ApiListResponse<SecFiling>>(res)
  return Array.isArray(payload.data) ? payload.data : []
}

export async function fetchFilingSentiment(accessNumber: string): Promise<FilingSentiment> {
  const params = new URLSearchParams({ accessNumber })
  const res = await fetch(`/api/market/filings-sentiment?${params.toString()}`)
  const payload = await parseJson<ApiObjectResponse<FilingSentiment>>(res)
  return payload.data || {}
}

export async function fetchEarningsCalendar(
  symbol: string,
  options?: { pastDays?: number; futureDays?: number },
): Promise<EarningsEvent[]> {
  const params = new URLSearchParams({ symbol: symbol.trim() })
  if (options?.pastDays) params.set('pastDays', String(options.pastDays))
  if (options?.futureDays) params.set('futureDays', String(options.futureDays))
  const res = await fetch(`/api/market/earnings-calendar?${params.toString()}`)
  const payload = await parseJson<ApiListResponse<EarningsEvent>>(res)
  return Array.isArray(payload.data) ? payload.data : []
}

export async function fetchWatchlistEarnings(
  options?: { pastDays?: number; futureDays?: number; refresh?: boolean },
): Promise<WatchlistEarningsResponse> {
  const params = new URLSearchParams()
  if (options?.pastDays) params.set('pastDays', String(options.pastDays))
  if (options?.futureDays) params.set('futureDays', String(options.futureDays))
  if (options?.refresh) params.set('refresh', 'true')
  const query = params.toString()
  const res = await fetch(`/api/market/watchlist-earnings${query ? `?${query}` : ''}`)
  return parseJson<WatchlistEarningsResponse>(res)
}

export async function fetchInsiderTransactions(
  symbol: string,
  options?: { days?: number },
): Promise<InsiderTransaction[]> {
  const params = new URLSearchParams({ symbol: symbol.trim() })
  if (options?.days) params.set('days', String(options.days))
  const res = await fetch(`/api/market/insider-transactions?${params.toString()}`)
  const payload = await parseJson<ApiListResponse<InsiderTransaction>>(res)
  return Array.isArray(payload.data) ? payload.data : []
}

export async function fetchWatchlistInsiderTransactions(
  options?: { symbol?: string; days?: number; limit?: number; refresh?: boolean },
): Promise<WatchlistInsiderResponse> {
  const params = new URLSearchParams()
  if (options?.symbol) params.set('symbol', options.symbol.trim())
  if (options?.days) params.set('days', String(options.days))
  if (options?.limit) params.set('limit', String(options.limit))
  if (options?.refresh) params.set('refresh', 'true')
  const query = params.toString()
  const res = await fetch(`/api/market/watchlist-insider-transactions${query ? `?${query}` : ''}`)
  return parseJson<WatchlistInsiderResponse>(res)
}

export function finnhubSymbol(tradingsymbol: string): string {
  let symbol = tradingsymbol.trim().toUpperCase()
  for (const suffix of ['-EQ', '-BE', '-SM', '-BZ', '-BL']) {
    if (symbol.endsWith(suffix)) symbol = symbol.slice(0, -suffix.length)
  }
  if (symbol.includes('.')) symbol = symbol.split('.')[0]
  return symbol
}

export function formatFilingDate(value?: string): string {
  if (!value) return '—'
  const parsed = new Date(value.replace(' ', 'T'))
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function formatEarningsHour(hour?: string): string {
  if (!hour) return '—'
  const map: Record<string, string> = {
    bmo: 'Before open',
    amc: 'After close',
    dmh: 'During session',
  }
  return map[hour.toLowerCase()] || hour.toUpperCase()
}

export function formatCompactMoney(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}K`
  return `$${value.toFixed(2)}`
}

export function formatPct(value?: number | null, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(digits)}%`
}

/** Finnhub Loughran-McDonald scores are already word-share percentages (e.g. 1.27 = 1.27%). */
export function formatSentimentShare(value?: number | null, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value.toFixed(digits)}%`
}

export function formatPolarityScore(value?: number | null, digits = 3): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return value.toFixed(digits)
}

export function isUpcomingEarnings(event: EarningsEvent, today = new Date()): boolean {
  if (event.epsActual != null || event.revenueActual != null) return false
  if (!event.date) return true
  const parsed = new Date(`${event.date}T12:00:00`)
  if (Number.isNaN(parsed.getTime())) return true
  const day = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  return parsed >= day
}

const INSIDER_CODE_LABELS: Record<string, string> = {
  P: 'Purchase',
  S: 'Sale',
  A: 'Grant / award',
  M: 'Option exercise',
  G: 'Gift',
  F: 'Tax / fee payment',
  C: 'Conversion',
  X: 'Exercise (derivative)',
  D: 'Disposition to issuer',
  J: 'Other',
}

const INSIDER_BUY_CODES = new Set(['P', 'A', 'M', 'X', 'C', 'G'])
const INSIDER_SELL_CODES = new Set(['S', 'D', 'F'])

export function coerceInsiderChange(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).replace(/\u2212/g, '-'))
  return Number.isFinite(n) ? n : null
}

export function resolveInsiderSide(
  row: Pick<InsiderTransaction, 'change' | 'transactionCode'>,
): 'buy' | 'sell' | 'neutral' {
  const change = coerceInsiderChange(row.change)
  if (change != null && change !== 0) {
    return change > 0 ? 'buy' : 'sell'
  }

  const code = row.transactionCode?.trim().toUpperCase()
  if (code && INSIDER_SELL_CODES.has(code)) return 'sell'
  if (code && INSIDER_BUY_CODES.has(code)) return 'buy'
  return 'neutral'
}

export function formatInsiderSide(change?: number | null): 'buy' | 'sell' | 'neutral' {
  return resolveInsiderSide({ change, transactionCode: undefined })
}

export function formatInsiderSideLabel(
  row: Pick<InsiderTransaction, 'change' | 'transactionCode'>,
): string {
  const side = resolveInsiderSide(row)
  if (side === 'buy') return 'Buy'
  if (side === 'sell') return 'Sell'
  return 'Neutral'
}

export function formatTransactionCode(code?: string): string {
  if (!code) return '—'
  const key = code.trim().toUpperCase()
  const label = INSIDER_CODE_LABELS[key]
  return label ? `${key} · ${label}` : key
}

export function formatShareCount(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 })
}
