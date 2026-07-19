export type OnePercentSelectionMode = 'deterministic' | 'agent' | 'hybrid'
export type OnePercentScreenerMode = 'auto' | 'manual'

export type OnePercentSessionConfig = {
  capital: number
  target_pct: number
  take_profit_pct: number
  stop_loss_pct: number
  max_attempts: number
  selection_mode: OnePercentSelectionMode
  target_dollars: number
  min_score: number
  screener_mode: OnePercentScreenerMode
  query_keys: string[]
  screener_ids: string[]
  focus_symbols: string[]
  agent_model?: string | null
  agent_model_params?: Array<{ id: string; value: string }>
}

export type OnePercentPreset = {
  key: string
  name: string
  description: string
  phase: string
}

export type OnePercentSessionState =
  | 'created'
  | 'verifying_balance'
  | 'screening'
  | 'selecting'
  | 'configuring'
  | 'placing'
  | 'monitoring'
  | 'evaluating'
  | 'finished'
  | 'stopped'

export type OnePercentSession = {
  id: string
  broker: string
  account_env: 'demo' | 'live' | string
  trading_day: string
  state: OnePercentSessionState
  config: OnePercentSessionConfig
  attempt_count: number
  max_attempts: number
  cumulative_pnl: number
  target_dollars: number
  active_attempt_id: string | null
  active_order_id: string | null
  active_position_id: string | null
  active_symbol: string | null
  terminal_reason: string | null
  version: number
  started_at: string | null
  finished_at: string | null
  created_at: string
  updated_at: string
}

export type OnePercentSessionEvent = {
  id: number
  session_id: string
  event_type: string
  state: string | null
  payload: Record<string, unknown>
  created_at: string
}

export type OnePercentSessionDetail = OnePercentSession & {
  attempts: Array<Record<string, unknown>>
  events: OnePercentSessionEvent[]
}

export type OnePercentEligibility = {
  account_env: string
  required_capital: number
  available_cash: number | null
  sufficient: boolean
  active_session_id: string | null
  can_start: boolean
  reasons: string[]
  checked_at: string
}

export type CreateOnePercentSessionInput = {
  account_env: 'demo' | 'live'
  capital: number
  target_pct: number
  take_profit_pct: number
  stop_loss_pct: number
  max_attempts: number
  selection_mode?: OnePercentSelectionMode
  min_score?: number
  screener_mode?: OnePercentScreenerMode
  query_keys?: string[]
  screener_ids?: string[]
  focus_symbols?: string[]
  agent_model?: string | null
  agent_model_params?: Array<{ id: string; value: string }>
}

const API = '/api/control/one-percent-sessions'

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text()
  let body: {
    status?: boolean
    data?: T
    detail?: string
    message?: string
  } = {}
  if (text.trim()) {
    try {
      body = JSON.parse(text) as typeof body
    } catch {
      throw new Error(
        res.ok
          ? 'Invalid JSON from control plane'
          : 'Control plane unavailable — wait for make dev to finish starting, then refresh.',
      )
    }
  } else if (!res.ok) {
    throw new Error(
      'Control plane unavailable — wait for make dev to finish starting, then refresh.',
    )
  }
  if (!res.ok || body.status === false) {
    const detail = body.detail
    throw new Error(
      typeof detail === 'string'
        ? detail
        : body.message || res.statusText || 'Request failed',
    )
  }
  return body.data as T
}

export async function fetchOnePercentDefaults(): Promise<OnePercentSessionConfig> {
  const res = await fetch(`${API}/defaults`)
  return parseJson(res)
}

export async function fetchOnePercentPresets(): Promise<OnePercentPreset[]> {
  const res = await fetch(`${API}/presets`)
  return parseJson(res)
}

export async function fetchOnePercentEligibility(
  accountEnv: string,
  capital: number,
): Promise<OnePercentEligibility> {
  const params = new URLSearchParams({
    account_env: accountEnv,
    capital: String(capital),
  })
  const res = await fetch(`${API}/eligibility?${params}`)
  return parseJson(res)
}

export async function listOnePercentSessions(accountEnv?: string): Promise<OnePercentSession[]> {
  const params = new URLSearchParams()
  if (accountEnv) params.set('account_env', accountEnv)
  const qs = params.toString()
  const res = await fetch(`${API}${qs ? `?${qs}` : ''}`)
  return parseJson(res)
}

export async function createOnePercentSession(
  input: CreateOnePercentSessionInput,
): Promise<OnePercentSessionDetail> {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return parseJson(res)
}

export async function getOnePercentSession(sessionId: string): Promise<OnePercentSessionDetail> {
  const res = await fetch(`${API}/${encodeURIComponent(sessionId)}`)
  return parseJson(res)
}

export async function pollOnePercentSessionEvents(
  sessionId: string,
  sinceId = 0,
): Promise<OnePercentSessionEvent[]> {
  const params = new URLSearchParams({ since_id: String(sinceId), limit: '500' })
  const res = await fetch(`${API}/${encodeURIComponent(sessionId)}/events?${params}`)
  return parseJson(res)
}

export async function stopOnePercentSession(
  sessionId: string,
  reason = 'Stopped by user',
): Promise<OnePercentSessionDetail> {
  const res = await fetch(`${API}/${encodeURIComponent(sessionId)}/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  })
  return parseJson(res)
}

export async function deleteOnePercentSession(sessionId: string): Promise<void> {
  const res = await fetch(`${API}/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
  await parseJson(res)
}

export function onePercentSessionLabel(session: OnePercentSession): string {
  const capital = session.config?.capital ?? 1000
  const target = session.target_dollars ?? session.config?.target_dollars ?? 10
  return `1% · $${capital} → $${target}`
}

export function isTerminalOnePercentState(state: string | null | undefined): boolean {
  return state === 'finished' || state === 'stopped'
}
