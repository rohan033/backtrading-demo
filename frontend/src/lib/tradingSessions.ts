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
  /** Actual capital deployed — populated from portfolio/orders once trades exist. */
  actual_capital_used?: number | null
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
  /** Optional free-text instruction to steer the agent (esp. AI discovery). */
  prompt?: string | null
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

export async function deleteTradingSession(id: string): Promise<{ id: string; deleted: boolean }> {
  const res = await fetch(`/api/control/trading-sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  return parseJson<{ id: string; deleted: boolean }>(res)
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

/** Hide internal phase-gate messages from user-facing UI. */
export function displayStoppedReason(reason: string | null | undefined): string | null {
  if (!reason) return null
  const text = reason.trim()
  if (!text) return null
  if (text.startsWith('Phase 1:') || text.includes('not implemented in Phase 1')) return null
  return text
}

export function displayStateReason(reason: string | null | undefined): string | null {
  if (!reason) return null
  const text = reason.trim()
  if (!text) return null
  if (text.toLowerCase() === 'session created') return null
  return displayStoppedReason(text)
}

export function pipelineProgress(
  state: TradingSessionState,
  stateLog?: TradingSessionStateLogEntry[],
): { currentIdx: number; furthestIdx: number } {
  const stoppedIdx = SESSION_PIPELINE.indexOf('stopped')
  const currentIdx = SESSION_PIPELINE.indexOf(state)
  if (state !== 'stopped') {
    return { currentIdx: currentIdx >= 0 ? currentIdx : 0, furthestIdx: currentIdx >= 0 ? currentIdx : 0 }
  }
  let furthestIdx = 0
  for (const entry of stateLog ?? []) {
    const to = entry.to_state as TradingSessionState | null | undefined
    if (!to || to === 'stopped') continue
    const idx = SESSION_PIPELINE.indexOf(to)
    if (idx >= 0) furthestIdx = Math.max(furthestIdx, idx)
  }
  return { currentIdx: stoppedIdx, furthestIdx }
}

export type SessionOutcome = 'running' | 'stopped' | 'success'

export function sessionOutcomeLabel(session: TradingSession): SessionOutcome {
  if (session.state !== 'stopped') return 'running'
  const reason = (session.stopped_reason || '').toLowerCase()
  if (reason.includes('profit target') || reason.includes('trade complete')) {
    return 'success'
  }
  return 'stopped'
}

export function showSessionInstructionInput(session: TradingSession): boolean {
  return session.state === 'stopped'
}
