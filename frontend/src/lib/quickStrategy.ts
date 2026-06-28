import {
  resolveTakeProfitLongPercent,
  startControlledExecution,
  TAKE_PROFIT_MODE_ABSOLUTE,
  TAKE_PROFIT_MODE_PERCENT,
} from '../ExecutionWorkspace'
import { EXECUTION_SOURCE_USER } from './executionSources'
import { loadTradingDayOptions } from './tradingSchedule'
import type { WatchlistBroker } from './watchlists'

const CONTROL_API = '/api/control'

export type QuickStrategyInput = {
  broker: WatchlistBroker
  accountEnv: 'demo' | 'live'
  symbol: string
  token: string
  exchange: string
  closePrice: number
  tpPct: number
  tpAmount: number | null
  slPct: number
  slAmount: number | null
  maxCapital: number
  scheduled: boolean
  scheduledDate: string | null
  deployNow: boolean
}

function stopLossAmountValue(value: number | null): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null
  return value
}

export async function createQuickStrategy(input: QuickStrategyInput): Promise<string> {
  const stopLossAmount = stopLossAmountValue(input.slAmount)
  const takeProfitMode = input.tpAmount != null && input.tpAmount > 0
    ? TAKE_PROFIT_MODE_ABSOLUTE
    : TAKE_PROFIT_MODE_PERCENT

  const formLike = {
    close_price: input.closePrice,
    initial_threshold: 0,
    long_percent: input.tpPct,
    short_percent: input.slPct,
    stop_loss_amount: stopLossAmount ?? '',
    max_available_capital: input.maxCapital,
    allow_partial_stocks: true,
  }

  const longPercent = resolveTakeProfitLongPercent(
    formLike,
    takeProfitMode,
    input.tpAmount != null ? String(input.tpAmount) : '',
  )

  const body = {
    source_id: EXECUTION_SOURCE_USER,
    broker: input.broker,
    account_env: input.accountEnv,
    strategy_name: 'one-percent',
    symbol: input.symbol,
    token: input.token,
    exchange: input.exchange,
    close_price: input.closePrice,
    long_percent: longPercent,
    short_percent: input.slPct,
    stop_loss_amount: stopLossAmount,
    initial_threshold: 0,
    max_available_capital: input.maxCapital,
    allow_partial_stocks: true,
    schedule_enabled: input.scheduled && !input.deployNow,
    scheduled_date: input.scheduled && !input.deployNow ? input.scheduledDate : null,
    start_immediately: input.deployNow,
  }

  const res = await fetch(`${CONTROL_API}/executions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) {
    throw new Error(data.detail || 'Failed to create strategy')
  }

  const executionId = data.data.execution_id as string
  if (input.deployNow) {
    await startControlledExecution(executionId)
  }
  return executionId
}

export async function loadQuickStrategySchedule(broker: WatchlistBroker) {
  const options = await loadTradingDayOptions(broker)
  return options.options
}
