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
