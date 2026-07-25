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
  indexes?: string[]
}

export type ScreenerPreset = {
  key: string
  name: string
  description: string
  phase: string
  definition: ScreenerDefinition
}

export type ScreenerResultRow = {
  id: string
  position: number
  ticker: string
  name: string
  cells: Record<string, unknown>
  rank?: number
  rank_jump?: number | null
  rank_jump_day?: number | null
}

export type ScreenerSourceType =
  | 'tradingview'
  | 'stock_catalyst_nyse_pm'
  | 'stock_catalyst_nyse_ah'
  | string

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
  source_type?: ScreenerSourceType
  source_url?: string | null
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

export async function fetchScreenerPresets(): Promise<ScreenerPreset[]> {
  return parseJson(await fetch(`${API}/presets`))
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

export type GenerateScreenerResult = {
  name: string
  explanation: string
  definition: ScreenerDefinition
  dsl_text: string
  screener?: Screener | null
}

export async function generateScreenerFromText(
  prompt: string,
  {
    create = true,
    modelId,
    modelParams,
  }: {
    create?: boolean
    modelId?: string | null
    modelParams?: Array<{ id: string; value: string }>
  } = {},
): Promise<GenerateScreenerResult> {
  return parseJson(
    await fetch(`${API}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        create,
        model_id: modelId || null,
        model_params: (modelParams || []).filter(p => p.id && p.value),
      }),
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
  payload?: {
    tickers?: string[]
    account_env?: string
    instrument_overrides?: Record<string, number>
  },
): Promise<{ screener: Screener; summary: WatchlistSyncSummary }> {
  return parseJson(
    await fetch(`${API}/${id}/watchlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    }),
  )
}
