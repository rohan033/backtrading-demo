import type { WatchlistPanel } from './watchlists'
import { formatApiError } from './apiError'

const API = '/api/watchlist-panels'

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
    throw new Error('Panel API returned no data')
  }
  return payload.data as T
}

export async function fetchWatchlistPanels(): Promise<WatchlistPanel[]> {
  return parseJson(await fetch(API))
}

export async function createWatchlistPanel(name: string): Promise<WatchlistPanel> {
  return parseJson(
    await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  )
}

export async function updateWatchlistPanel(
  id: string,
  patch: { name?: string; position?: number },
): Promise<WatchlistPanel> {
  return parseJson(
    await fetch(`${API}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  )
}

export async function deleteWatchlistPanel(id: string): Promise<void> {
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
