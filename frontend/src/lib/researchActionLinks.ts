import type { AiResearchAction } from '@/lib/aiResearch'

const TITLE_TICKER_SKIP = new Set([
  'OPEN',
  'SEC',
  'AI',
  'ETF',
  'IPO',
  'CHIPS',
  'LIVE',
  'POST',
  'EDT',
  'EST',
  'USA',
  'USD',
  'API',
  'MCP',
  'Q',
  'K',
])

export type ResearchSessionExecution = {
  execution_id: string
  engine?: {
    id?: string
    symbol?: string
    status?: string
    metadata?: {
      source_id?: string
      source_meta_id?: string
      execution_config?: { symbol?: string; close_price?: number; source_meta_id?: string }
      executor_payload?: { close_price?: number }
    }
  }
}

export function normalizeSymbol(value: string): string {
  const text = value.trim().toUpperCase()
  if (!text) return ''
  return text.split('-')[0].split('.')[0]
}

export function symbolFromTitle(title: string): string | null {
  const matches = title.toUpperCase().match(/\b[A-Z][A-Z0-9]{1,5}\b/g) || []
  for (const token of matches) {
    if (!TITLE_TICKER_SKIP.has(token)) return token
  }
  return null
}

export function symbolFromAction(action: AiResearchAction): string | null {
  const payload = action.payload || {}
  const raw = String(payload.symbol || '').trim()
  if (raw) return normalizeSymbol(raw) || null
  return symbolFromTitle(action.title || '')
}

function symbolFromExecution(row: ResearchSessionExecution): string | null {
  const engine = row.engine || {}
  const config = engine.metadata?.execution_config || {}
  const raw = String(engine.symbol || config.symbol || '').trim()
  if (!raw) return null
  return normalizeSymbol(raw) || null
}

function belongsToSession(row: ResearchSessionExecution, sessionId: string): boolean {
  const metadata = row.engine?.metadata || {}
  const config = metadata.execution_config || {}
  if (metadata.source_id && metadata.source_id !== 'ai_research') return false
  const metaId = String(metadata.source_meta_id || config.source_meta_id || '')
  return metaId === sessionId
}

export function filterSessionExecutions(
  rows: ResearchSessionExecution[],
  sessionId: string,
): ResearchSessionExecution[] {
  return rows.filter(row => row.execution_id && belongsToSession(row, sessionId))
}

export function resolveExecutionIdForAction(
  action: AiResearchAction,
  sessionExecutions: ResearchSessionExecution[],
  claimedEngineIds: Set<string>,
): string | null {
  const stored = String(action.payload?.execution_id || '').trim()
  if (stored) return stored

  const actionSymbol = symbolFromAction(action)
  if (!actionSymbol) return null

  const payload = action.payload || {}
  let candidates = sessionExecutions.filter(row => {
    const id = row.execution_id
    if (!id || claimedEngineIds.has(id)) return false
    return symbolFromExecution(row) === actionSymbol
  })

  if (!candidates.length) return null

  const closePrice = Number(payload.close_price || 0)
  if (closePrice > 0 && candidates.length > 1) {
    const narrowed = candidates.filter(row => {
      const config = row.engine?.metadata?.execution_config || {}
      const executor = row.engine?.metadata?.executor_payload || {}
      const engineClose = Number(executor.close_price ?? config.close_price ?? 0)
      return engineClose > 0 && Math.abs(engineClose - closePrice) <= 0.01
    })
    if (narrowed.length) candidates = narrowed
  }

  return candidates[0]?.execution_id || null
}
