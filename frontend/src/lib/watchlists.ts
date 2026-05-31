export type WatchlistSymbol = {
  id: string
  symboltoken: string
  tradingsymbol: string
  exchange: string
  symbol: string
}

export type WatchlistBroker = 'angel' | 'etoro'

export type Watchlist = {
  id: string
  name: string
  position: number
  broker: WatchlistBroker
  account_env: string
  created_at: string
  updated_at: string
  symbols: WatchlistSymbol[]
}

export type WatchlistTick = {
  token: string
  ltp: number
  change_pct: number
  direction: 'up' | 'down' | 'flat'
}

import { formatApiError } from './apiError'

const API = '/api/watchlists'

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
  if (payload.data === undefined && res.ok) {
    throw new Error('Watchlist API returned no data — restart the control-plane server if you just deployed.')
  }
  return payload.data as T
}

export async function fetchWatchlists(): Promise<Watchlist[]> {
  return parseJson(await fetch(API))
}

export function watchlistTickKey(
  broker: string,
  accountEnv: string,
  token: string,
): string {
  return `${broker}:${accountEnv}:${token}`
}

export async function createWatchlist(
  name: string,
  options?: { broker?: WatchlistBroker; account_env?: string },
): Promise<Watchlist> {
  return parseJson(
    await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ...options }),
    }),
  )
}

export async function updateWatchlist(
  id: string,
  patch: { name?: string; broker?: WatchlistBroker; account_env?: string },
): Promise<Watchlist> {
  return parseJson(
    await fetch(`${API}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  )
}

export async function renameWatchlist(id: string, name: string): Promise<Watchlist> {
  return updateWatchlist(id, { name })
}

export async function deleteWatchlist(id: string): Promise<void> {
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

export async function addWatchlistSymbol(
  watchlistId: string,
  symbol: { symboltoken: string; tradingsymbol: string; exchange: string },
): Promise<Watchlist> {
  return parseJson(
    await fetch(`${API}/${watchlistId}/symbols`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(symbol),
    }),
  )
}

export async function removeWatchlistSymbol(
  watchlistId: string,
  symboltoken: string,
): Promise<Watchlist> {
  return parseJson(
    await fetch(`${API}/${watchlistId}/symbols/${encodeURIComponent(symboltoken)}`, {
      method: 'DELETE',
    }),
  )
}

export function watchlistWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/ws/watchlist`
}
