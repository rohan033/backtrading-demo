import { formatApiError } from './apiError'

const API = '/api/screeners'

export type ScreenerField = {
  key: string
  label: string
  type: string
  ops: { id: string; label: string }[]
}

export type ScreenerFilterCond = {
  left: string
  operation: string
  right?: unknown
}

export type ScreenerFilterGroup = {
  operator: 'and' | 'or'
  conditions: Array<ScreenerFilterCond | ScreenerFilterGroup>
}

export type ScreenerDefinition = {
  columns: string[]
  filters: ScreenerFilterCond[]
  filter_group?: ScreenerFilterGroup | null
  order_by?: string | null
  ascending?: boolean
  limit?: number
  offset?: number
  market?: string
}

export type ScreenerResultRow = {
  id: string
  position: number
  ticker: string
  name: string
  cells: Record<string, unknown>
}

export type Screener = {
  id: string
  name: string
  definition: ScreenerDefinition
  dsl_text: string
  auto_refresh_seconds: number
  watchlist_id?: string | null
  total_count: number
  refresh_status: 'idle' | 'running' | 'ok' | 'error' | string
  last_refreshed_at?: string | null
  last_error?: string | null
  position: number
  created_at: string
  updated_at: string
  results: ScreenerResultRow[]
}

export type WatchlistSyncSummary = {
  watchlist_id: string
  watchlist_name: string
  account_env: string
  added: number
  already_present: number
  unmatched: number
  failed: number
  items: Array<{
    ticker: string
    symbol: string
    status: string
    symboltoken?: string
    error?: string
  }>
}

async function parseJson<T>(res: Response): Promise<T> {
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    if (!res.ok) throw new Error(res.statusText || 'Request failed')
    throw new Error('Invalid response from server')
  }
  const payload = body as { status?: boolean; data?: T; detail?: unknown }
  if (!res.ok || payload.status === false) {
    throw new Error(formatApiError(body, res.statusText || 'Request failed'))
  }
  return payload.data as T
}

export async function fetchScreenerFields(): Promise<ScreenerField[]> {
  return parseJson(await fetch(`${API}/fields`))
}

export async function fetchScreeners(includeResults = false): Promise<Screener[]> {
  const qs = includeResults ? '?include_results=true' : ''
  return parseJson(await fetch(`${API}${qs}`))
}

export async function fetchScreener(id: string): Promise<Screener> {
  return parseJson(await fetch(`${API}/${id}`))
}

export async function createScreener(payload: {
  name: string
  definition?: ScreenerDefinition
  dsl_text?: string
  auto_refresh_seconds?: number
}): Promise<Screener> {
  return parseJson(
    await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

export async function updateScreener(
  id: string,
  patch: {
    name?: string
    definition?: ScreenerDefinition
    dsl_text?: string
    auto_refresh_seconds?: number
  },
): Promise<Screener> {
  return parseJson(
    await fetch(`${API}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  )
}

export async function deleteScreener(id: string): Promise<void> {
  const res = await fetch(`${API}/${id}`, { method: 'DELETE' })
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    if (!res.ok) throw new Error(res.statusText || 'Request failed')
    return
  }
  const payload = body as { status?: boolean }
  if (!res.ok || payload.status === false) {
    throw new Error(formatApiError(body, res.statusText || 'Request failed'))
  }
}

export async function validateScreenerDsl(dsl_text: string): Promise<{
  definition: ScreenerDefinition
  dsl_text: string
}> {
  return parseJson(
    await fetch(`${API}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dsl_text }),
    }),
  )
}

export async function refreshScreener(id: string): Promise<Screener> {
  return parseJson(
    await fetch(`${API}/${id}/refresh`, {
      method: 'POST',
    }),
  )
}

export async function syncScreenerWatchlist(
  id: string,
  payload?: { tickers?: string[]; account_env?: string },
): Promise<{ screener: Screener; summary: WatchlistSyncSummary }> {
  return parseJson(
    await fetch(`${API}/${id}/watchlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    }),
  )
}
