import { userTextSurface } from '@/components/agent/A2uiRenderer'
import type { A2uiSurfaceMessage } from '@/lib/agentA2uiCatalog'
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

export function surfacesFromThreadActions(actions: AgentThreadAction[]): A2uiSurfaceMessage[] {
  const surfaces: A2uiSurfaceMessage[] = []
  for (const action of actions) {
    if (!action.payload?.symbol) continue
    surfaces.push(componentSurface('StrategySetupForm', {
      title: action.title || 'Strategy setup',
      actionId: action.id,
      status: action.status || 'open',
      ...action.payload,
    }, 'agent', `action-${action.id}`))
  }
  return surfaces
}

export function surfacesFromThreadMessages(
  messages: AgentThreadMessage[],
  actions: AgentThreadAction[] = [],
): A2uiSurfaceMessage[] {
  const surfaces: A2uiSurfaceMessage[] = []
  const actionIds = new Set<string>()

  for (const message of messages) {
    if (message.role === 'user') {
      const text = message.content.trim()
      if (text) surfaces.push(userTextSurface(text, message.id))
      continue
    }
    if (message.role === 'assistant') {
      const expanded = expandAssistantContent(message.content, message.id)
      for (const surface of expanded) {
        if (surface.components[0]?.component === 'StrategySetupForm') {
          const actionId = String(surface.components[0].props.actionId || '')
          if (actionId) actionIds.add(actionId)
        }
        surfaces.push(surface)
      }
      const summary = message.metadata?.reply_summary
      if (summary) {
        surfaces.push(componentSurface('InsightCards', {
          highlights: summary.highlights || [],
          lowlights: summary.lowlights || [],
          cautions: summary.cautions || [],
        }, 'agent', `${message.id}-stored-summary`))
      }
      continue
    }
    if (message.role === 'tool') {
      const toolLog = toolLogSurface(message)
      if (toolLog) surfaces.push(toolLog)
    }
  }

  for (const action of actions) {
    if (actionIds.has(action.id)) continue
    if (!action.payload?.symbol) continue
    surfaces.push(componentSurface('StrategySetupForm', {
      title: action.title || 'Strategy setup',
      actionId: action.id,
      status: action.status || 'open',
      ...action.payload,
    }, 'agent', `action-${action.id}`))
  }

  return surfaces
}

export function observationSurface(
  focus: AgentThreadFocus,
  executionStatus?: string | null,
): A2uiSurfaceMessage {
  const status = (executionStatus || 'saved').toLowerCase()
  const live = status === 'running' || status === 'active'
  const text = live
    ? `Live on ${focus.symbol}`
    : `Watching ${focus.symbol}`
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
