import { userTextSurface } from '@/components/agent/A2uiRenderer'
import type { A2uiComponentName, A2uiSurfaceMessage } from '@/lib/agentA2uiCatalog'
import type { AgentThreadAction, AgentThreadFocus, AgentThreadMessage } from '@/lib/agentThreads'

const FENCE_START_RE = /```(?:json|a2ui)?\s*/gi

const ALLOWED_COMPONENTS = new Set([
  'Text',
  'Heading',
  'BulletList',
  'TradeDecision',
  'ToolStatus',
  'StrategySummary',
  'StrategySetupForm',
  'InsightCards',
  'ButtonRow',
  'TopStockPicks',
  'CandidateDebate',
  'MonitorBatch',
])

function* iterFencedJsonBlocks(text: string): Generator<{ fullMatch: string; payload: Record<string, unknown> }> {
  const re = new RegExp(FENCE_START_RE.source, FENCE_START_RE.flags)
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const bodyStart = match.index + match[0].length
    const endIdx = text.indexOf('```', bodyStart)
    if (endIdx === -1) continue
    const raw = text.slice(bodyStart, endIdx).trim()
    if (!raw.startsWith('{')) continue
    try {
      const payload = JSON.parse(raw) as Record<string, unknown>
      if (!payload || typeof payload !== 'object') continue
      yield { fullMatch: text.slice(match.index, endIdx + 3), payload }
    } catch {
      // ignore malformed fences
    }
  }
}

function a2uiBlockFromPayload(payload: Record<string, unknown>) {
  const block = payload.a2ui as { component?: string; props?: Record<string, unknown> } | undefined
  if (block?.component && ALLOWED_COMPONENTS.has(block.component)) {
    return block
  }
  const component = typeof payload.component === 'string' ? payload.component : ''
  if (component && ALLOWED_COMPONENTS.has(component)) {
    return {
      component,
      props: (payload.props || {}) as Record<string, unknown>,
    }
  }
  return null
}

function isRecognizedFencePayload(payload: Record<string, unknown>): boolean {
  if (a2uiBlockFromPayload(payload)) return true
  if (payload.ai_action && typeof payload.ai_action === 'object') return true
  if (payload.ai_summary && typeof payload.ai_summary === 'object') return true
  return false
}

function collapseMarkdownProse(text: string, maxLen = 120): string {
  let cleaned = text.trim()
  if (!cleaned) return ''

  for (const { fullMatch, payload } of iterFencedJsonBlocks(cleaned)) {
    if (isRecognizedFencePayload(payload)) {
      cleaned = cleaned.replace(fullMatch, '')
    }
  }

  cleaned = cleaned
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\n?\**sources?\**\s*:.*$/gis, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (cleaned.length > maxLen) {
    return `${cleaned.slice(0, maxLen - 1).trimEnd()}…`
  }
  return cleaned
}

function componentSurface(
  component: string,
  props: Record<string, unknown>,
  role: 'user' | 'agent',
  messageId: string,
): A2uiSurfaceMessage {
  return {
    type: 'a2ui_surface',
    messageId,
    role,
    components: [{
      id: `${messageId}-root`,
      component: component as A2uiSurfaceMessage['components'][0]['component'],
      props,
    }],
  }
}

function expandAssistantContent(content: string, messageId: string): A2uiSurfaceMessage[] {
  const surfaces: A2uiSurfaceMessage[] = []

  for (const { payload } of iterFencedJsonBlocks(content)) {
    const block = a2uiBlockFromPayload(payload)
    if (block?.component) {
      surfaces.push(componentSurface(
        block.component,
        block.props || {},
        'agent',
        `${messageId}-a2ui-${surfaces.length}`,
      ))
      continue
    }

    const action = payload.ai_action as Record<string, unknown> | undefined
    if (action && typeof action === 'object') {
      const actionType = String(action.type || '').toLowerCase()
      if (['trade_complete', 'trade_completed', 'session_complete'].includes(actionType)) {
        const actionPayload = (action.payload || {}) as Record<string, unknown>
        const symbol = String(actionPayload.symbol || '')
        const pnl = actionPayload.pnl
        const outcome = String(actionPayload.outcome || '')
        let text = `Trade closed — ${outcome || 'done'}`
        if (pnl != null) text += ` · PnL ${pnl}`
        surfaces.push(componentSurface('TradeDecision', { symbol, text }, 'agent', `${messageId}-complete-${surfaces.length}`))
        continue
      }
      const actionPayload = (action.payload || {}) as Record<string, unknown>
      surfaces.push(componentSurface('StrategySetupForm', {
        title: action.title || 'Strategy setup',
        actionId: action.id,
        status: action.status || 'open',
        ...actionPayload,
      }, 'agent', `${messageId}-action-${surfaces.length}`))
      continue
    }

    const summary = payload.ai_summary as Record<string, unknown> | undefined
    if (summary && typeof summary === 'object') {
      surfaces.push(componentSurface('InsightCards', {
        highlights: summary.highlights || [],
        lowlights: summary.lowlights || [],
        cautions: summary.cautions || [],
      }, 'agent', `${messageId}-summary-${surfaces.length}`))
    }
  }

  const plain = collapseMarkdownProse(content)
  if (plain) {
    surfaces.push(componentSurface('Text', { text: plain }, 'agent', `${messageId}-text`))
  }
  return surfaces
}

function readMonitorBatchMeta(message: AgentThreadMessage) {
  return message.metadata?.monitor_batch
}

function isMonitorBatchUserMessage(message: AgentThreadMessage): boolean {
  if (message.metadata?.source === 'agent_monitor') return true
  const text = message.content.trim()
  return text.startsWith('[Monitor batch]') || text.startsWith('[monitor_batch]')
}

function isMonitorBatchAssistantMessage(message: AgentThreadMessage): boolean {
  if (message.id.startsWith('monitor-')) return true
  if (message.metadata?.source === 'agent_monitor' && message.metadata?.monitor_batch) return true
  return message.content.trim().startsWith('[monitor_batch]')
}

function monitorBatchSurfaceFromMessage(message: AgentThreadMessage): A2uiSurfaceMessage | null {
  const batch = readMonitorBatchMeta(message)
  if (batch) {
    return {
      type: 'a2ui_surface',
      messageId: message.id,
      role: 'agent',
      components: [{
        id: `${message.id}-monitor`,
        component: 'MonitorBatch',
        props: {
          symbol: batch.symbol || '—',
          eventCount: batch.eventCount || 0,
          items: batch.items || [],
          kinds: (batch.items || []).map(item => String(item.kind || '')),
        },
      }],
    }
  }

  const compact = message.content.trim().match(/^\[monitor_batch\]\s+([^\s·]+)\s*·\s*(\d+)\s+updates/i)
  if (compact) {
    return {
      type: 'a2ui_surface',
      messageId: message.id,
      role: 'agent',
      components: [{
        id: `${message.id}-monitor`,
        component: 'MonitorBatch',
        props: {
          symbol: compact[1],
          eventCount: Number(compact[2]),
          items: [],
          kinds: [],
        },
      }],
    }
  }

  const legacy = message.content.match(/\[Monitor batch\] Review (\d+) queued updates for ([^\s.]+)/i)
  if (!legacy) return null
  return {
    type: 'a2ui_surface',
    messageId: message.id,
    role: 'agent',
    components: [{
      id: `${message.id}-monitor`,
      component: 'MonitorBatch',
      props: {
        eventCount: Number(legacy[1]),
        symbol: legacy[2],
        items: [],
        kinds: [],
      },
    }],
  }
}

function toolLogSurface(message: AgentThreadMessage): A2uiSurfaceMessage | null {
  if (!message.tool_name) return null
  return {
    type: 'a2ui_tool_log',
    messageId: message.id,
    role: 'agent',
    components: [
      {
        id: `${message.id}-tool`,
        component: 'ToolStatus',
        props: {
          toolName: message.tool_name,
          status: message.tool_status || 'done',
          detail: message.tool_detail || message.content || '',
        },
      },
    ],
  }
}

function surfaceFromMessage(message: AgentThreadMessage): A2uiSurfaceMessage[] {
  if (message.role === 'user') {
    if (isMonitorBatchUserMessage(message)) {
      const monitorSurface = monitorBatchSurfaceFromMessage(message)
      return monitorSurface ? [monitorSurface] : []
    }
    const text = message.content.trim()
    return text ? [userTextSurface(text, message.id)] : []
  }

  if (message.role === 'assistant') {
    if (isMonitorBatchAssistantMessage(message)) {
      const monitorSurface = monitorBatchSurfaceFromMessage(message)
      return monitorSurface ? [monitorSurface] : []
    }
    const expanded = expandAssistantContent(message.content, message.id)
    const summary = message.metadata?.reply_summary
    if (summary) {
      expanded.push(componentSurface('InsightCards', {
        highlights: summary.highlights || [],
        lowlights: summary.lowlights || [],
        cautions: summary.cautions || [],
      }, 'agent', `${message.id}-stored-summary`))
    }
    return expanded
  }

  if (message.role === 'tool') {
    const toolLog = toolLogSurface(message)
    return toolLog ? [toolLog] : []
  }

  return []
}

export function dedupeSurfaces(surfaces: A2uiSurfaceMessage[]): A2uiSurfaceMessage[] {
  const seen = new Set<string>()
  const rows: A2uiSurfaceMessage[] = []
  for (const surface of surfaces) {
    if (seen.has(surface.messageId)) continue
    seen.add(surface.messageId)
    rows.push(surface)
  }
  return rows
}

export function surfacesFromThreadActions(actions: AgentThreadAction[]): A2uiSurfaceMessage[] {
  const surfaces: A2uiSurfaceMessage[] = []
  for (const action of actions) {
    if (!action.payload?.symbol) continue
    const status = String(action.status || '').toLowerCase()
    const hasExec = Boolean(action.payload.execution_id)
    const live = hasExec || status === 'running' || status === 'active' || status === 'starting'
    if (live) {
      surfaces.push(componentSurface('StrategySummary', {
        symbol: String(action.payload.symbol).split('-')[0],
        long_percent: action.payload.long_percent,
        short_percent: action.payload.short_percent,
        capital: action.payload.max_available_capital,
        execution_id: action.payload.execution_id,
        status: status || 'running',
        entry_price: action.payload.close_price,
        broker: action.payload.broker,
        account_env: action.payload.account_env,
      }, 'agent', `action-${action.id}-live`))
      continue
    }
    surfaces.push(componentSurface('StrategySetupForm', {
      title: action.title || 'Strategy setup',
      actionId: action.id,
      status: action.status || 'open',
      ...action.payload,
    }, 'agent', `action-${action.id}`))
  }
  return surfaces
}

function isDeployedAction(action: AgentThreadAction): boolean {
  const status = String(action.status || '').toLowerCase()
  return Boolean(action.payload?.execution_id)
    || status === 'running'
    || status === 'active'
    || status === 'starting'
}

export function surfacesFromThreadMessages(
  messages: AgentThreadMessage[],
  actions: AgentThreadAction[] = [],
): A2uiSurfaceMessage[] {
  const surfaces: A2uiSurfaceMessage[] = []
  const actionIds = new Set<string>()
  const deployedActionIds = new Set(
    actions.filter(isDeployedAction).map(action => action.id),
  )

  for (const message of messages) {
    try {
      for (const surface of surfaceFromMessage(message)) {
        if (surface.components[0]?.component === 'StrategySetupForm') {
          const actionId = String(surface.components[0].props.actionId || '')
          if (actionId) {
            actionIds.add(actionId)
            if (deployedActionIds.has(actionId)) continue
          }
        }
        surfaces.push(surface)
      }
    } catch {
      // skip malformed historical rows without breaking the whole feed
    }
  }

  for (const action of actions) {
    if (actionIds.has(action.id)) continue
    if (!action.payload?.symbol) continue
    const status = String(action.status || '').toLowerCase()
    const live = isDeployedAction(action)
    if (live) {
      surfaces.push(componentSurface('StrategySummary', {
        symbol: String(action.payload.symbol).split('-')[0],
        long_percent: action.payload.long_percent,
        short_percent: action.payload.short_percent,
        capital: action.payload.max_available_capital,
        execution_id: action.payload.execution_id,
        status: status || 'running',
        entry_price: action.payload.close_price,
        broker: action.payload.broker,
        account_env: action.payload.account_env,
      }, 'agent', `action-${action.id}-live`))
      continue
    }
    surfaces.push(componentSurface('StrategySetupForm', {
      title: action.title || 'Strategy setup',
      actionId: action.id,
      status: action.status || 'open',
      ...action.payload,
    }, 'agent', `action-${action.id}`))
  }

  return dedupeSurfaces(surfaces)
}

export function observationSurface(
  focus: AgentThreadFocus,
  executionStatus?: string | null,
  livePrice?: number | null,
): A2uiSurfaceMessage {
  const status = (executionStatus || 'saved').toLowerCase()
  const live = status === 'running' || status === 'active' || status === 'starting'
  if (live) {
    return deployedSummarySurface(focus, focus.execution_id || null, executionStatus, livePrice)
  }
  const text = `Watching ${focus.symbol}`
  return {
    type: 'a2ui_surface',
    messageId: `observe-${focus.symbol}`,
    role: 'agent',
    components: [
      {
        id: `observe-${focus.symbol}-root`,
        component: 'TradeDecision',
        props: { symbol: focus.symbol, text },
      },
    ],
  }
}

export function deployedSummarySurface(
  focus: AgentThreadFocus,
  executionId?: string | null,
  executionStatus?: string | null,
  livePrice?: number | null,
): A2uiSurfaceMessage {
  const symbol = focus.symbol?.split('-')[0] || focus.symbol || '—'
  const entry = livePrice != null && livePrice > 0 ? livePrice : focus.close_price
  return {
    type: 'a2ui_surface',
    messageId: `deployed-${executionId || symbol}`,
    role: 'agent',
    components: [
      {
        id: `deployed-${executionId || symbol}-root`,
        component: 'StrategySummary',
        props: {
          symbol,
          long_percent: focus.long_percent,
          short_percent: focus.short_percent,
          capital: focus.max_available_capital,
          execution_id: executionId || focus.execution_id,
          status: executionStatus || 'running',
          entry_price: entry,
          broker: focus.broker,
          account_env: focus.account_env,
        },
      },
    ],
  }
}

const PRE_DEPLOY_COMPONENTS = new Set<A2uiComponentName>([
  'StrategySetupForm',
  'InsightCards',
  'CandidateDebate',
  'TopStockPicks',
  'ButtonRow',
])

export function compactSurfacesAfterDeploy(
  surfaces: A2uiSurfaceMessage[],
  deployed: boolean,
): A2uiSurfaceMessage[] {
  if (!deployed) return surfaces
  return surfaces
    .map(surface => ({
      ...surface,
      components: surface.components.filter(
        component => !PRE_DEPLOY_COMPONENTS.has(component.component),
      ),
    }))
    .filter(surface => surface.components.length > 0)
}

// Back-compat alias (older bundles referenced this name).
export const monitorBatchSurfaceFromUserMessage = monitorBatchSurfaceFromMessage

/** Parse fenced A2UI blocks from raw assistant text (trading sessions, etc.). */
export function surfacesFromAssistantText(content: string, messageId: string): A2uiSurfaceMessage[] {
  return expandAssistantContent(content, messageId).filter(
    surface => surface.components[0]?.component !== 'Text',
  )
}

export function stripRecognizedFences(text: string): string {
  return collapseMarkdownProse(text, 100_000)
}
