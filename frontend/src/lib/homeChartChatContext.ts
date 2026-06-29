import { finnhubSymbol } from './marketResearch'
import { stripResearchTagMentions } from './researchChatTags'
import {
  WATCHLIST_BROKER_OPTIONS,
  type WatchlistBroker,
} from './watchlistBrokers'

export type HomeChartChatContext = {
  fromTime: number
  toTime: number
  kind: 'stock' | 'indices'
  broker: WatchlistBroker
  accountEnv: string
  symbol?: string
  displayName?: string
  indices?: string[]
}

export function formatBrokerLabel(broker: WatchlistBroker): string {
  return WATCHLIST_BROKER_OPTIONS.find(option => option.value === broker)?.label ?? broker
}

function formatBrokerWithEnv(broker: WatchlistBroker, accountEnv: string): string {
  const label = formatBrokerLabel(broker)
  return accountEnv === 'demo' ? `${label} demo` : label
}

function formatChartSubjects(context: HomeChartChatContext): string {
  if (context.kind === 'indices') {
    return context.indices?.join(', ') || 'SPX500, NSDQ100, DJ30'
  }
  const symbol = context.symbol || 'Symbol'
  if (context.displayName && context.displayName !== symbol) {
    return `${symbol} (${context.displayName})`
  }
  return symbol
}

export function formatChartRangeTime(time: number): string {
  return new Date(time * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatChartRangeLabel(context: HomeChartChatContext): string {
  const from = formatChartRangeTime(context.fromTime)
  const to = formatChartRangeTime(context.toTime)
  const subject = formatChartSubjects(context)
  const broker = formatBrokerWithEnv(context.broker, context.accountEnv)
  return `${subject} · ${broker} · ${from} – ${to}`
}

/** Prefilled chat draft when a chart range is added to AI chat. */
export function buildChartRangeChatDraft(context: HomeChartChatContext): string {
  const from = formatChartRangeTime(context.fromTime)
  const to = formatChartRangeTime(context.toTime)
  const subjects = formatChartSubjects(context)
  const broker = formatBrokerWithEnv(context.broker, context.accountEnv)
  return `@chartanalysis ${subjects} · ${broker} · ${from} – ${to}\n`
}

export function buildChartRangeAgentPrompt(
  userText: string,
  context: HomeChartChatContext,
): string {
  const question = stripResearchTagMentions(userText)
  const from = formatChartRangeTime(context.fromTime)
  const to = formatChartRangeTime(context.toTime)

  const subjectBlock = context.kind === 'indices'
    ? `Indices: ${context.indices?.join(', ') || 'SPX500, NSDQ100, DJ30'}`
    : `Symbol: ${finnhubSymbol(context.symbol || '').toUpperCase()}`

  const block = [
    '[CHART TIME RANGE]',
    subjectBlock,
    `Broker: ${formatBrokerWithEnv(context.broker, context.accountEnv)}`,
    `Window: ${from} → ${to}`,
    'Analyze price action, trend, momentum, volatility, support/resistance, and volume behavior during this window.',
    'Call out what changed across the range and what it implies next.',
    '[/CHART TIME RANGE]',
  ].join('\n')

  const body = question
    || (context.kind === 'indices'
      ? 'Summarize what happened across these indices in this window and what to watch next.'
      : 'Summarize what happened in this window and what it implies going forward.')

  return `${block}\n\n${body}`
}
