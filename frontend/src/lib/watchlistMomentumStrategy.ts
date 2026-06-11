import { startControlledExecution } from '../ExecutionWorkspace'
import { EXECUTION_SOURCE_MOMENTUM_TRADE } from './executionSources'
import type { MomentumConfig } from './watchlistMomentum'

const CONTROL_API = '/api/control'

export type MomentumSymbolContext = {
  broker: string
  tradingsymbol: string
  token: string
  exchange: string
  closePrice: number
}

function defaultClientMode(broker: string): string {
  return broker === 'etoro' ? 'bracket' : 'standard'
}

export function buildMomentumStrategyPayload(
  ctx: MomentumSymbolContext,
  accountEnv: 'live' | 'demo',
  config: MomentumConfig,
) {
  return {
    source_id: EXECUTION_SOURCE_MOMENTUM_TRADE,
    broker: ctx.broker,
    account_env: accountEnv,
    strategy_name: 'one-percent',
    symbol: ctx.tradingsymbol,
    token: ctx.token,
    exchange: ctx.exchange || (ctx.broker === 'etoro' ? 'ETORO' : 'NSE'),
    close_price: ctx.closePrice,
    long_percent: config.longPercent,
    short_percent: config.shortPercent,
    initial_threshold: config.initialThreshold,
    max_available_capital: config.maxCapital,
    allow_partial_stocks: ctx.broker === 'etoro',
    use_fake_client: false,
    client_mode: defaultClientMode(ctx.broker),
    feed_mode: 'websocket',
    tick_sample_every: 1,
    schedule_enabled: false,
    scheduled_date: null,
    start_immediately: true,
    instrument_class: 'equity',
  }
}

export async function createAndStartMomentumStrategy(
  ctx: MomentumSymbolContext,
  accountEnv: 'live' | 'demo',
  config: MomentumConfig,
): Promise<string> {
  const res = await fetch(`${CONTROL_API}/executions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildMomentumStrategyPayload(ctx, accountEnv, config)),
  })
  const data = await res.json()
  if (!res.ok) {
    // FastAPI 422 returns detail as an array of field errors; flatten to a readable string
    const detail = data.detail
    const message =
      typeof detail === 'string'
        ? detail
        : Array.isArray(detail)
          ? detail.map((e: { loc?: string[]; msg?: string }) =>
              `${(e.loc ?? []).slice(1).join('.')}: ${e.msg ?? e}`
            ).join('; ')
          : (data.message ?? `HTTP ${res.status}`)
    throw new Error(message || 'Failed to create momentum strategy')
  }
  const executionId = String(data.data?.execution_id || '')
  if (!executionId) {
    throw new Error('Momentum strategy created without execution id')
  }
  await startControlledExecution(executionId)
  return executionId
}
