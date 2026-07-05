export type TradingSessionState =
  | 'explore'
  | 'research'
  | 'strategy'
  | 'deploy'
  | 'monitor'
  | 'stopped'

export type TradingSession = {
  id: string
  state: TradingSessionState
  environment: string
  broker: string
  account_env: string
  max_capital: number
  profit_target: number
  symbol?: string | null
  token?: string | null
  exchange?: string | null
  stopped_reason?: string | null
  strategy_type?: string | null
  engine_id?: string | null
  total_pnl: number
  created_at: string
  updated_at: string
  state_log?: TradingSessionStateLogEntry[]
}

export type TradingSessionStateLogEntry = {
  id: number
  session_id: string
  from_state?: string | null
  to_state: string
  reason?: string | null
  created_at: string
}

export type TradingSessionEvent = {
  id: number
  session_id: string
  event_type: string
  payload: Record<string, unknown>
  created_at: string
}

export type CreateTradingSessionInput = {
  symbol?: string | null
  token?: string | null
  exchange?: string | null
  broker?: string
  account_env?: 'live' | 'demo' | string
  max_capital: number
  profit_target: number
}

async function parseJson<T>(res: Response): Promise<T> {
  const body = await res.json()
  if (!res.ok || body.status === false) {
    throw new Error(body.message || body.detail || res.statusText || 'Request failed')
  }
  return body.data as T
}

export async function listTradingSessions(state?: string): Promise<TradingSession[]> {
  const params = new URLSearchParams()
  if (state) params.set('state', state)
  const qs = params.toString()
  const res = await fetch(`/api/control/trading-sessions${qs ? `?${qs}` : ''}`)
  return parseJson<TradingSession[]>(res)
}

export async function createTradingSession(input: CreateTradingSessionInput): Promise<TradingSession> {
  const res = await fetch('/api/control/trading-sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return parseJson<TradingSession>(res)
}

export async function getTradingSession(id: string): Promise<TradingSession> {
  const res = await fetch(`/api/control/trading-sessions/${encodeURIComponent(id)}`)
  return parseJson<TradingSession>(res)
}

export async function stopTradingSession(id: string, reason = 'Stopped by user'): Promise<TradingSession> {
  const res = await fetch(`/api/control/trading-sessions/${encodeURIComponent(id)}/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  })
  return parseJson<TradingSession>(res)
}

export async function dispatchTradingSessionPrompt(id: string, prompt: string): Promise<TradingSession> {
  const res = await fetch(`/api/control/trading-sessions/${encodeURIComponent(id)}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
  return parseJson<TradingSession>(res)
}

export async function pollTradingSessionEvents(
  id: string,
  sinceId = 0,
): Promise<TradingSessionEvent[]> {
  const params = new URLSearchParams({ since_id: String(sinceId) })
  const res = await fetch(
    `/api/control/trading-sessions/${encodeURIComponent(id)}/events?${params}`,
  )
  return parseJson<TradingSessionEvent[]>(res)
}

export const SESSION_PIPELINE: TradingSessionState[] = [
  'explore',
  'research',
  'strategy',
  'deploy',
  'monitor',
  'stopped',
]

export function sessionLabel(session: TradingSession): string {
  if (session.symbol) return session.symbol
  if (session.state === 'explore') return 'Discovering…'
  return 'No symbol'
}
