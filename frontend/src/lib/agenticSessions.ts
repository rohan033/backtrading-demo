import { formatApiError } from './apiError'

const API = '/api/agentic'

export type AgenticSessionStatus = 'running' | 'stopped'
export type AgenticAccountEnv = 'demo' | 'live'

export type AgenticSessionStats = {
  trades_placed: number
  realized_pnl: number
  unrealized_pnl: number
  invested: number
  win_rate: number | null
  open_positions: number
}

export type AgenticSession = {
  id: string
  name: string
  prompt: string
  status: AgenticSessionStatus
  account_env: AgenticAccountEnv | string
  start_balance: number
  config: Record<string, unknown>
  started_at: string | null
  stopped_at: string | null
  stop_reason: string | null
  created_at: string
  updated_at: string
  stats: AgenticSessionStats
}

export type AgenticSessionEventType =
  | 'suggestion'
  | 'entry'
  | 'exit'
  | 'trim'
  | 'state_change'
  | 'reconciliation'
  | 'error'
  | 'stop'
  | 'info'

export type AgenticSessionEvent = {
  id: number
  session_id: string
  ts: string
  type: AgenticSessionEventType
  ticker: string | null
  text: string
  meta: Record<string, unknown>
}

export type AgenticPositionState =
  | 'pending_open'
  | 'open'
  | 'pending_close'
  | 'closed'
  | 'failed'

export type AgenticExitState = 'running' | 'weakening' | 'exit'

export type AgenticSessionPosition = {
  id: string
  session_id: string
  ticker: string
  state: AgenticPositionState
  exit_state: AgenticExitState
  units: number
  buy_price: number
  stop_loss: number
  current_price: number
  realized_pnl: number
  unrealized_pnl: number
  intent_id: string
  opened_at: string | null
  closed_at: string | null
}

export type AgenticSuggestion = {
  id: string
  ticker: string
  score: number
  source_screener: string
  reason: string
  price: number
  spread_pct: number
  generated_at: string
}

export type CreateAgenticSessionInput = {
  name?: string
  prompt?: string
  account_env: AgenticAccountEnv
  start_balance?: number
  config?: Record<string, unknown>
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

export async function listAgenticSessions(): Promise<AgenticSession[]> {
  return parseJson(await fetch(`${API}/sessions`))
}

export async function createAgenticSession(
  input: CreateAgenticSessionInput,
): Promise<AgenticSession> {
  return parseJson(
    await fetch(`${API}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  )
}

export async function getAgenticSession(id: string): Promise<AgenticSession> {
  return parseJson(await fetch(`${API}/sessions/${encodeURIComponent(id)}`))
}

export async function stopAgenticSession(id: string): Promise<AgenticSession> {
  return parseJson(
    await fetch(`${API}/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
  )
}

/** Only allowed when the session is stopped. */
export async function deleteAgenticSession(id: string): Promise<void> {
  const res = await fetch(`${API}/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
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

/** Events are returned ascending by id; pass `afterId` for incremental polling. */
export async function listAgenticSessionEvents(
  id: string,
  afterId = 0,
  limit = 500,
): Promise<AgenticSessionEvent[]> {
  const params = new URLSearchParams({ after_id: String(afterId), limit: String(limit) })
  return parseJson(
    await fetch(`${API}/sessions/${encodeURIComponent(id)}/events?${params}`),
  )
}

export async function listAgenticSessionPositions(
  id: string,
): Promise<AgenticSessionPosition[]> {
  return parseJson(await fetch(`${API}/sessions/${encodeURIComponent(id)}/positions`))
}

export async function closeAgenticPosition(
  sessionId: string,
  positionId: string,
): Promise<AgenticSessionPosition> {
  return parseJson(
    await fetch(
      `${API}/sessions/${encodeURIComponent(sessionId)}/positions/${encodeURIComponent(positionId)}/close`,
      { method: 'POST' },
    ),
  )
}

/** Newest first. */
export async function listAgenticSuggestions(limit = 30): Promise<AgenticSuggestion[]> {
  const params = new URLSearchParams({ limit: String(limit) })
  return parseJson(await fetch(`${API}/suggestions?${params}`))
}

export function agenticSessionLabel(session: AgenticSession): string {
  return session.name?.trim() || `Session ${session.id.slice(0, 8)}`
}

export function agenticApiUnavailable(message: string): boolean {
  return message === 'Not Found'
}
