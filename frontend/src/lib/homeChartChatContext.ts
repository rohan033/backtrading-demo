import { finnhubSymbol } from './marketResearch'
import { stripResearchTagMentions } from './researchChatTags'

export type HomeChartChatContext = {
  fromTime: number
  toTime: number
  kind: 'stock' | 'indices'
  symbol?: string
  displayName?: string
  indices?: string[]
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
  const subject = context.kind === 'indices'
    ? (context.indices?.join(', ') || 'US indices')
    : (context.displayName || context.symbol || 'Symbol')
  return `${subject} · ${from} – ${to}`
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
