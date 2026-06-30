import { formatBrokerMoney } from './currency'
import type { ChartOpportunitySignal } from './chartOpportunityDetector'
import { EXECUTION_SOURCE_CHART_OPPORTUNITY } from './executionSources'

export const CHART_OPPORTUNITY_LOCK_KEY = 'home-chart-opportunity-lock'
import {
  formatChartRangeTime,
  type HomeChartChatContext,
} from './homeChartChatContext'
import { finnhubSymbol } from './marketResearch'
import type { WatchlistBroker } from './watchlistBrokers'

export type ChartOpportunityChatContext = HomeChartChatContext & {
  opportunity: ChartOpportunitySignal
  autoTriggered?: boolean
}

export function formatOpportunityKind(kind: ChartOpportunitySignal['kind']): string {
  switch (kind) {
    case 'breakout_up':
      return 'Upside breakout'
    case 'breakout_down':
      return 'Downside breakout'
    case 'momentum_up':
      return 'Bullish momentum'
    case 'momentum_down':
      return 'Bearish momentum'
    case 'rsi_reversal_up':
      return 'RSI oversold bounce'
    case 'rsi_reversal_down':
      return 'RSI overbought fade'
    case 'volume_spike':
      return 'Volume spike'
    default:
      return kind
  }
}

export function buildChartOpportunityChatDraft(context: ChartOpportunityChatContext): string {
  const from = formatChartRangeTime(context.fromTime)
  const to = formatChartRangeTime(context.toTime)
  const symbol = context.symbol || 'Symbol'
  const label = formatOpportunityKind(context.opportunity.kind)
  return `@chartanalysis ${symbol} · ${label} · ${from} – ${to}\n`
}

export function buildChartOpportunityAgentPrompt(context: ChartOpportunityChatContext): string {
  const { opportunity } = context
  const symbol = finnhubSymbol(context.symbol || '').toUpperCase()
  const from = formatChartRangeTime(context.fromTime)
  const to = formatChartRangeTime(context.toTime)
  const broker = context.broker
  const accountEnv = context.accountEnv
  const entry = formatBrokerMoney(broker, opportunity.levels.entry)
  const stop = formatBrokerMoney(broker, opportunity.levels.stop)
  const target = formatBrokerMoney(broker, opportunity.levels.target)

  const candleTool = broker === 'etoro'
    ? '`get_watchlist_symbol_candles` or `get_watchlist_symbol_candles_history` with broker=etoro'
    : '`get_historical_candles` for Angel tokens'

  return [
    '[AUTO CHART OPPORTUNITY]',
    `Symbol: ${symbol}`,
    `Broker: ${broker}${accountEnv === 'demo' ? ' demo' : ''}`,
    `Window: ${from} → ${to}`,
    `Signal: ${formatOpportunityKind(opportunity.kind)} (${opportunity.direction.toUpperCase()}, score ${opportunity.score})`,
    `Reasons: ${opportunity.reasons.join('; ')}`,
    `Suggested entry: ${entry}`,
    `Suggested stop: ${stop}`,
    `Suggested target: ${target}`,
    `Risk/reward: ${opportunity.levels.riskReward.toFixed(2)}`,
    `Indicators: RSI ${opportunity.indicators.rsi?.toFixed(1) ?? '—'}, momentum15m ${opportunity.indicators.momentum15mPct.toFixed(2)}%, volume z ${opportunity.indicators.volumeZ.toFixed(1)}`,
  '[/AUTO CHART OPPORTUNITY]',
    '',
    'You are in Execute mode. Build one risk-managed strategy for this setup.',
    'Required workflow:',
    `1. Call \`get_portfolio\` for broker=${broker} account_env=${accountEnv} and size the trade from available cash/equity.`,
    `2. Fetch candles with ${candleTool}; do NOT use Angel historical API for eToro tokens.`,
    `3. Validate the setup still makes sense on the latest bars in this window.`,
    `4. Call \`create_strategy\` with source_id="${EXECUTION_SOURCE_CHART_OPPORTUNITY}" and conservative risk controls.`,
    '5. In your reply, annotate: entry, stop, target, position size, max loss, and profit potential.',
    'Only create one strategy for this opportunity. Skip if portfolio cash is insufficient or the setup already played out.',
  ].join('\n')
}
