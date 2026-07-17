import { formatApiError } from './apiError'

const API = '/api/traded-instruments'

export type TradedInstrument = {
  id: string
  broker: string
  account_env: string
  symboltoken: string
  tradingsymbol: string
  exchange: string
  symbol: string
  internal_asset_class_name?: string | null
  instrument_display_name?: string | null
  logo35x35?: string | null
  logo50x50?: string | null
  logo150x150?: string | null
  raw_metadata_json?: string | null
  last_position_id?: string | null
  last_side?: string | null
  trade_count: number
  first_traded_at?: string | null
  last_traded_at?: string | null
  metadata_updated_at?: string | null
}

export type RecordTradedInstrumentInput = {
  symboltoken: string
  tradingsymbol: string
  broker?: string
  account_env?: string
  exchange?: string
  symbol?: string | null
  internal_asset_class_name?: string | null
  instrument_display_name?: string | null
  logo35x35?: string | null
  logo50x50?: string | null
  logo150x150?: string | null
  raw_metadata?: Record<string, unknown> | null
  position_id?: string | null
  side?: string | null
  bump_trade_count?: boolean
}

async function parseJson<T>(res: Response): Promise<T> {
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    if (!res.ok) throw new Error(res.statusText || 'Request failed')
    throw new Error('Invalid response from server')
  }
  const payload = body as { status?: boolean; data?: T }
  if (!res.ok || payload.status === false) {
    throw new Error(formatApiError(body, res.statusText || 'Request failed'))
  }
  return payload.data as T
}

export async function fetchTradedInstruments(
  options?: { broker?: string; account_env?: string },
): Promise<TradedInstrument[]> {
  const params = new URLSearchParams()
  if (options?.broker) params.set('broker', options.broker)
  if (options?.account_env) params.set('account_env', options.account_env)
  const query = params.toString()
  return parseJson(await fetch(query ? `${API}?${query}` : API))
}

export async function recordTradedInstrument(
  input: RecordTradedInstrumentInput,
): Promise<TradedInstrument> {
  return parseJson(
    await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ broker: 'etoro', account_env: 'demo', ...input }),
    }),
  )
}

export async function deleteTradedInstrument(
  symboltoken: string,
  options?: { broker?: string; account_env?: string },
): Promise<void> {
  const params = new URLSearchParams()
  params.set('broker', options?.broker || 'etoro')
  params.set('account_env', options?.account_env || 'demo')
  const res = await fetch(`${API}/${encodeURIComponent(symboltoken)}?${params.toString()}`, {
    method: 'DELETE',
  })
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
