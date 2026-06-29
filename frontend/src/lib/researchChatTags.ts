import { edgarSearchUrl, formatEdgarAgentContext } from './edgar'
import { finnhubSymbol } from './marketResearch'

export type ResearchChatTagId =
  | 'insidertrading'
  | 'earnings'
  | 'filings'
  | 'news'
  | 'chartanalysis'

export type ResearchChatTag = {
  id: ResearchChatTagId
  label: string
  mention: string
  description: string
}

export const RESEARCH_CHAT_TAGS: ResearchChatTag[] = [
  {
    id: 'insidertrading',
    label: 'Insider',
    mention: '@insidertrading',
    description: 'Form 3/4/5 buy and sell activity',
  },
  {
    id: 'earnings',
    label: 'Earnings',
    mention: '@earnings',
    description: 'Upcoming and reported EPS / revenue',
  },
  {
    id: 'filings',
    label: 'Filings',
    mention: '@filings',
    description: 'SEC 10-K, 10-Q, and 8-K review',
  },
  {
    id: 'news',
    label: 'News',
    mention: '@news',
    description: 'Recent headlines and catalysts',
  },
  {
    id: 'chartanalysis',
    label: 'Chart',
    mention: '@chartanalysis',
    description: 'Price action, trend, and levels',
  },
]

const TAG_BY_MENTION = new Map(
  RESEARCH_CHAT_TAGS.map(tag => [tag.mention.toLowerCase(), tag.id]),
)

function normalizeToken(symbol: string): string {
  return finnhubSymbol(symbol).trim().toUpperCase()
}

export function extractResearchTags(text: string): ResearchChatTagId[] {
  const found = new Set<ResearchChatTagId>()
  const pattern = /@([a-z][a-z0-9]*)/gi
  for (const match of text.matchAll(pattern)) {
    const id = TAG_BY_MENTION.get(`@${String(match[1]).toLowerCase()}`)
    if (id) found.add(id)
  }
  return RESEARCH_CHAT_TAGS.filter(tag => found.has(tag.id)).map(tag => tag.id)
}

export function stripResearchTagMentions(text: string): string {
  return text
    .replace(/@([a-z][a-z0-9]*)/gi, (_, raw: string) =>
      TAG_BY_MENTION.has(`@${raw.toLowerCase()}`) ? '' : `@${raw}`,
    )
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function insiderTradingContext(symbol: string): string {
  return [
    `[INSIDER TRADING — ${symbol}]`,
    `Analyze recent insider transactions for ${symbol} (Form 3/4/5).`,
    'Use Finnhub insider data and SEC filings when helpful. Summarize net buying vs selling, notable insiders, transaction size, and whether activity looks bullish, bearish, or neutral.',
    '[/INSIDER TRADING]',
  ].join('\n')
}

function earningsContext(symbol: string): string {
  return [
    `[EARNINGS — ${symbol}]`,
    `Review the earnings calendar for ${symbol}: upcoming report date, consensus EPS/revenue, and the most recent reported quarter.`,
    'Call out beats/misses, guidance tone, and what matters for the next print.',
    '[/EARNINGS]',
  ].join('\n')
}

function newsContext(symbol: string): string {
  return [
    `[COMPANY NEWS — ${symbol}]`,
    `Review recent news and headlines for ${symbol}. Use web search for live items when needed.`,
    'Summarize catalysts, risks, and what a trader should watch next.',
    '[/COMPANY NEWS]',
  ].join('\n')
}

function chartAnalysisContext(symbol: string): string {
  return [
    `[CHART ANALYSIS — ${symbol}]`,
    `Review recent price action for ${symbol}: trend, momentum, support/resistance, and volume behavior.`,
    'Use live market data when needed. Keep levels concrete and note bull/base/bear scenarios.',
    '[/CHART ANALYSIS]',
  ].join('\n')
}

function contextBlockForTag(tag: ResearchChatTagId, symbol: string): string {
  switch (tag) {
    case 'insidertrading':
      return insiderTradingContext(symbol)
    case 'earnings':
      return earningsContext(symbol)
    case 'filings':
      return formatEdgarAgentContext(symbol, edgarSearchUrl(symbol))
    case 'news':
      return newsContext(symbol)
    case 'chartanalysis':
      return chartAnalysisContext(symbol)
    default:
      return ''
  }
}

/** Expand @tags into agent context blocks, similar to SEC EDGAR wrapping in AI Research. */
export function buildResearchAgentPrompt(userText: string, symbol?: string): string {
  const text = userText.trim()
  if (!text) return ''

  const token = symbol ? normalizeToken(symbol) : ''
  const tags = extractResearchTags(text)
  const question = stripResearchTagMentions(text)

  const blocks: string[] = []
  if (token) {
    for (const tag of tags) {
      blocks.push(contextBlockForTag(tag, token))
    }
  }

  if (!blocks.length) {
    return question || text
  }

  const header = token ? `Symbol: ${token}` : ''
  const body = question || `Provide a concise research brief covering the tagged sections for ${token || 'this symbol'}.`
  return [header, ...blocks, body].filter(Boolean).join('\n\n')
}

export function insertResearchTagMention(draft: string, mention: string): string {
  const trimmed = draft.trimEnd()
  if (!trimmed) return `${mention} `
  if (trimmed.toLowerCase().includes(mention.toLowerCase())) return draft
  return `${trimmed} ${mention} `
}
