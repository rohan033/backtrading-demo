import { startControlledExecution } from '../ExecutionWorkspace'
import { EXECUTION_SOURCE_AI_RESEARCH } from './executionSources'
import { upsertResearchAction } from './aiResearch'
import { updateAgentThread } from './agentThreads'
import type { WatchlistBroker } from './watchlistBrokers'

const CONTROL_API = '/api/control'

export type AgentDeployPayload = {
  symbol: string
  token?: string
  exchange?: string
  broker?: string
  account_env?: string
  close_price?: number | null
  long_percent?: number
  short_percent?: number
  initial_threshold?: number
  max_available_capital?: number
  actionId?: string
  title?: string
}

function parseApiError(data: { detail?: unknown; message?: string }, status: number): string {
  const detail = data.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((e: { loc?: string[]; msg?: string }) => `${(e.loc ?? []).slice(1).join('.')}: ${e.msg ?? e}`)
      .join('; ')
  }
  return data.message ?? `HTTP ${status}`
}

async function linkDeployToThread(
  threadId: string,
  executionId: string,
  payload: AgentDeployPayload,
  accountEnv: 'live' | 'demo',
  entryPrice: number,
) {
  const symbol = String(payload.symbol || '')
  await upsertResearchAction(threadId, {
    id: payload.actionId,
    type: 'strategy_suggestion',
    title: payload.title || `${symbol.split('-')[0]} live`,
    status: 'running',
    payload: {
      ...payload,
      broker: payload.broker,
      account_env: accountEnv,
      close_price: entryPrice,
      execution_id: executionId,
    },
  })

  await updateAgentThread(threadId, {
    metadata: {
      ui_phase: 'trading',
      focus: {
        symbol,
        token: payload.token ?? null,
        exchange: payload.exchange || (payload.broker === 'etoro' ? 'ETORO' : 'NSE'),
        broker: payload.broker,
        account_env: accountEnv,
        close_price: entryPrice,
        long_percent: payload.long_percent ?? null,
        short_percent: payload.short_percent ?? null,
        initial_threshold: payload.initial_threshold ?? null,
        max_available_capital: payload.max_available_capital ?? null,
        execution_id: executionId,
      },
    },
  })
}

async function deployEtoroMomentum(
  threadId: string,
  payload: AgentDeployPayload,
  accountEnv: 'live' | 'demo',
  entryPrice: number,
): Promise<string> {
  const res = await fetch(`${CONTROL_API}/momentum/enter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      broker: 'etoro',
      account_env: accountEnv,
      symbol: payload.symbol,
      token: payload.token,
      exchange: payload.exchange || 'ETORO',
      close_price: entryPrice,
      long_percent: Number(payload.long_percent ?? 2),
      short_percent: Number(payload.short_percent ?? 1),
      max_available_capital: Number(payload.max_available_capital ?? 1000),
      allow_partial_stocks: true,
      source_id: EXECUTION_SOURCE_AI_RESEARCH,
      source_meta_id: threadId,
    }),
  })
  const data = await res.json()
  if (!res.ok) {
    throw new Error(parseApiError(data, res.status) || 'Failed to place trade')
  }
  const executionId = String(data.data?.execution_id || '')
  if (!executionId) {
    throw new Error('Trade placed without execution id')
  }
  return executionId
}

async function deployAngelImmediate(
  threadId: string,
  payload: AgentDeployPayload,
  accountEnv: 'live' | 'demo',
  entryPrice: number,
): Promise<string> {
  const body = {
    source_id: EXECUTION_SOURCE_AI_RESEARCH,
    source_meta_id: threadId,
    broker: 'angel',
    account_env: accountEnv,
    strategy_name: 'one-percent',
    symbol: payload.symbol,
    token: payload.token,
    exchange: payload.exchange || 'NSE',
    close_price: entryPrice,
    long_percent: Number(payload.long_percent ?? 2),
    short_percent: Number(payload.short_percent ?? 1),
    initial_threshold: Number(payload.initial_threshold ?? 0),
    max_available_capital: Number(payload.max_available_capital ?? 1000),
    allow_partial_stocks: false,
    start_immediately: true,
  }

  const res = await fetch(`${CONTROL_API}/executions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) {
    throw new Error(parseApiError(data, res.status) || 'Failed to create strategy')
  }
  const executionId = String(data.data?.execution_id || '')
  if (!executionId) {
    throw new Error('Strategy created without execution id')
  }
  await startControlledExecution(executionId)
  return executionId
}

/**
 * Agent-mode deploy: place the order at the current price first (eToro momentum path),
 * then attach a monitor-only strategy — same pattern as watchlist momentum trades.
 */
export async function deployAgentStrategy(params: {
  threadId: string
  payload: AgentDeployPayload
  broker: WatchlistBroker
  accountEnv: 'live' | 'demo'
  livePrice?: number | null
}): Promise<{ executionId: string; entryPrice: number }> {
  const { threadId, payload, broker, accountEnv, livePrice } = params
  const entryPrice =
  livePrice != null && Number.isFinite(livePrice) && livePrice > 0
    ? livePrice
    : Number(payload.close_price || 0)
  if (!entryPrice) {
    throw new Error('No entry price — wait for a live quote or refresh the chart')
  }
  if (!payload.token) {
    throw new Error('Missing instrument token for deploy')
  }

  const executionId =
    broker === 'etoro'
      ? await deployEtoroMomentum(threadId, payload, accountEnv, entryPrice)
      : await deployAngelImmediate(threadId, payload, accountEnv, entryPrice)

  await linkDeployToThread(threadId, executionId, payload, accountEnv, entryPrice)
  return { executionId, entryPrice }
}
