import { formatApiError } from './apiError'

const API = '/api/agentic'

export type AgenticSessionStatus = 'running' | 'paused' | 'stopped'
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
  | 'thinking'

/** Provenance + {data, oneline, confidence} contract fields carried in event meta. */
export type AgenticEventMeta = {
  agent?: string
  provenance?: string
  tier?: string | null
  run_id?: string | null
  kind?: string
  data?: string
  oneline?: string
  confidence?: number
  synthetic?: boolean
  type?: string
  [key: string]: unknown
}

export type AgenticSessionEvent = {
  id: number
  session_id: string
  ts: string
  type: AgenticSessionEventType | string
  ticker: string | null
  text: string
  meta: AgenticEventMeta
}

/** Streaming thinking block (tokens append into `text` while `done` is false). */
export type AgenticThinkingBlock = {
  run_id: string
  agent: string
  ticker: string | null
  text: string
  oneline: string
  done: boolean
  started_at: string
  updated_at: string
}

/** A short-lived sub-agent spawned by the orchestrator (Agents Status panel). */
export type AgenticSubagent = {
  id: string
  name: string
  tier: string | null
  ticker: string | null
  status: 'active' | 'done' | 'degraded' | string
  oneline: string
  data: string
  confidence: number | null
  run_id: string | null
  started_at: string
  finished_at: string | null
}

/** One of the five deterministic Market Monitor mini-cards. */
export type AgenticMonitorState = {
  name: string
  label: string
  status: 'idle' | 'active' | 'degraded' | 'unavailable' | string
  oneline: string
  data: Record<string, unknown>
  should_spawn_sub_agent: boolean
  updated_at: string | null
}

export type AgenticPositionState =
  | 'pending_open'
  | 'open'
  | 'pending_close'
  | 'closed'
  | 'failed'

export type AgenticExitState = 'running' | 'weakening' | 'exit'

export type AgenticExitPlanLevel = {
  id: string
  price: number
  fraction: number
  label: string
  hit?: boolean
}

export type AgenticExitPlan = {
  position_id: string
  ticker: string
  recent_high: number | null
  recent_low: number | null
  peak_price?: number | null
  window_seconds?: number
  window_minutes: number
  sample_count?: number
  profit_lock: number | null
  levels: AgenticExitPlanLevel[]
  levels_hit?: string[]
  next_level?: AgenticExitPlanLevel | null
  momentum?: string
  uptrend_intact?: boolean
  should_secure?: boolean
  peak_gain_pct?: number
  price_source?: string
  rebuy_candidate?: boolean
  active: boolean
  gain_pct?: number
  updated_at?: string
}

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
  exit_plan?: AgenticExitPlan | null
}

export type AgenticSuggestion = {
  id: string
  ticker: string
  score: number
  source?: string
  source_screener: string
  screener_id?: string | null
  reason: string
  price: number
  spread_pct: number | null
  generated_at: string
}

export type AgenticHunterStatus = {
  running: boolean
  scanning: boolean
  last_scan_at: string | null
  last_candidates_count: number
  last_emitted_count: number
}

export type AgenticStatus = {
  hunter: AgenticHunterStatus
  running_sessions: number
}

export type AgenticServiceState = {
  name: string
  status: string
  last_run_at: string | null
  current_work: string
  kind: 'deterministic' | 'llm'
}

export type AgenticRecommendation = {
  id: string
  created_at: string
  ticker: string | null
  event_type: string
  tier: string
  action: string
  summary: string
  confidence: number
  provenance: string
}

export type AgenticSessionSnapshot = {
  version: number
  session_id: string
  updated_at: string
  portfolio: {
    start_balance: number
    equity: number
    total_pnl: number
    daily_pnl: number
    invested: number
    exposure_pct: number
    max_exposure_pct: number
    win_rate: number | null
    open_positions: number
    trades_taken?: number
  }
  positions: AgenticSessionPosition[]
  playbooks: Record<string, Record<string, unknown>>
  events: AgenticSessionEvent[]
  alerts: Array<Record<string, unknown>>
  recommendations: AgenticRecommendation[]
  performance: Array<{ ts: string; equity: number }>
  services: Record<string, AgenticServiceState>
  monitors?: Record<string, AgenticMonitorState>
  subagents?: AgenticSubagent[]
  thinking?: AgenticThinkingBlock[]
  tasks: Array<Record<string, unknown>>
  agent_state: {
    orchestrator: string
    last_wakeup_at: string | null
    wakeups_last_hour: number
  }
}

export type CreateAgenticSessionInput = {
  name?: string
  prompt?: string
  account_env: AgenticAccountEnv
  start_balance?: number
  config?: Record<string, unknown>
  agent_model?: string | null
  agent_model_params?: Array<{ id: string; value: string }>
}

export type UpdateAgenticSessionModelInput = {
  agent_model?: string | null
  agent_model_params?: Array<{ id: string; value: string }>
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

export async function getAgenticSessionSnapshot(id: string): Promise<AgenticSessionSnapshot> {
  return parseJson(await fetch(`${API}/sessions/${encodeURIComponent(id)}/snapshot`))
}

export async function stopAgenticSession(id: string): Promise<AgenticSession> {
  return parseJson(
    await fetch(`${API}/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
  )
}

export async function pauseAgenticSession(id: string): Promise<AgenticSession> {
  return parseJson(
    await fetch(`${API}/sessions/${encodeURIComponent(id)}/pause`, { method: 'POST' }),
  )
}

export async function resumeAgenticSession(id: string): Promise<AgenticSession> {
  return parseJson(
    await fetch(`${API}/sessions/${encodeURIComponent(id)}/resume`, { method: 'POST' }),
  )
}

export async function updateAgenticSessionModel(
  id: string,
  input: UpdateAgenticSessionModelInput,
): Promise<AgenticSession> {
  return parseJson(
    await fetch(`${API}/sessions/${encodeURIComponent(id)}/agent-model`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
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

export async function getAgenticStatus(): Promise<AgenticStatus> {
  return parseJson(await fetch(`${API}/status`))
}

export function agenticSessionLabel(session: AgenticSession): string {
  return session.name?.trim() || `Session ${session.id.slice(0, 8)}`
}

export function agenticApiUnavailable(message: string): boolean {
  return message === 'Not Found'
}
