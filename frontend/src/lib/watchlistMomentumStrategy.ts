import type { MomentumConfig } from './watchlistMomentum'

const CONTROL_API = '/api/control'

export type MomentumSymbolContext = {
  broker: string
  tradingsymbol: string
  token: string
  exchange: string
  closePrice: number
  watchlistId?: string
}

export function buildMomentumEnterPayload(
  ctx: MomentumSymbolContext,
  accountEnv: 'live' | 'demo',
  config: MomentumConfig,
) {
  const watchlistId = ctx.watchlistId != null ? Number(ctx.watchlistId) : null
  return {
    broker: ctx.broker,
    account_env: accountEnv,
    symbol: ctx.tradingsymbol,
    token: ctx.token,
    exchange: ctx.exchange || (ctx.broker === 'etoro' ? 'ETORO' : 'NSE'),
    close_price: ctx.closePrice,
    long_percent: config.longPercent,
    short_percent: config.shortPercent,
    max_available_capital: config.maxCapital,
    allow_partial_stocks: ctx.broker === 'etoro',
    instrument_class: 'equity',
    watchlist_id: Number.isFinite(watchlistId) ? watchlistId : null,
  }
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

/**
 * Momentum fast-path: the backend checks the account balance, places the bracket
 * order (entry + 5% TP / 1% SL) immediately, then spins up a monitor-only strategy
 * that observes the position without placing any further orders.
 */
export async function createAndStartMomentumStrategy(
  ctx: MomentumSymbolContext,
  accountEnv: 'live' | 'demo',
  config: MomentumConfig,
): Promise<string> {
  const res = await fetch(`${CONTROL_API}/momentum/enter`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildMomentumEnterPayload(ctx, accountEnv, config)),
  })
  const data = await res.json()
  if (!res.ok) {
    throw new Error(parseApiError(data, res.status) || 'Failed to place momentum trade')
  }
  const executionId = String(data.data?.execution_id || '')
  if (!executionId) {
    throw new Error('Momentum trade placed without execution id')
  }
  return executionId
}
