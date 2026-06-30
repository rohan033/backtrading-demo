export const EXECUTION_SOURCE_USER = 'user'
export const EXECUTION_SOURCE_AI_RESEARCH = 'ai_research'
export const EXECUTION_SOURCE_AI_CHATBOT_PANEL = 'ai_chatbot_panel'
export const EXECUTION_SOURCE_CHART_OPPORTUNITY = 'chart_opportunity_auto'
export const EXECUTION_SOURCE_MOMENTUM_TRADE = 'momentum-trade'

export const EXECUTION_SOURCE_LABELS: Record<string, string> = {
  [EXECUTION_SOURCE_USER]: 'User',
  [EXECUTION_SOURCE_AI_RESEARCH]: 'AI Research',
  [EXECUTION_SOURCE_AI_CHATBOT_PANEL]: 'AI Chatbot',
  [EXECUTION_SOURCE_CHART_OPPORTUNITY]: 'Chart scan',
  [EXECUTION_SOURCE_MOMENTUM_TRADE]: 'Momentum',
}

type ExecutionMetadata = {
  source_id?: string | null
  source_meta_id?: string | null
  execution_config?: {
    source_id?: string | null
    source_meta_id?: string | null
  } | null
} | null | undefined

type ExecutionSourceContext = {
  source_id?: string | null
  source_meta_id?: string | null
  engine?: {
    metadata?: ExecutionMetadata
  } | null
} | null | undefined

function readSourceMetaId(context?: ExecutionSourceContext): string | null {
  const meta = context?.engine?.metadata
  return (
    context?.source_meta_id
    || meta?.source_meta_id
    || meta?.execution_config?.source_meta_id
    || null
  )
}

export function executionSourceLabel(sourceId?: string | null): string {
  if (!sourceId) return EXECUTION_SOURCE_LABELS[EXECUTION_SOURCE_USER]
  return EXECUTION_SOURCE_LABELS[sourceId] || sourceId
}

export function resolveExecutionSourceId(
  execution?: ExecutionSourceContext,
  queuedItem?: ExecutionSourceContext,
): string {
  const meta = execution?.engine?.metadata
  const queuedMeta = queuedItem?.engine?.metadata
  return (
    execution?.source_id
    || queuedItem?.source_id
    || queuedMeta?.source_id
    || queuedMeta?.execution_config?.source_id
    || meta?.source_id
    || meta?.execution_config?.source_id
    || EXECUTION_SOURCE_USER
  )
}

export function resolveExecutionSourceMetaId(
  execution?: ExecutionSourceContext,
  queuedItem?: ExecutionSourceContext,
): string | null {
  return readSourceMetaId(execution) || readSourceMetaId(queuedItem)
}

export function executionSourceHref(
  sourceId?: string | null,
  sourceMetaId?: string | null,
): string | null {
  if (sourceId !== EXECUTION_SOURCE_AI_RESEARCH || !sourceMetaId) return null
  return `/learn/research/${encodeURIComponent(sourceMetaId)}`
}
