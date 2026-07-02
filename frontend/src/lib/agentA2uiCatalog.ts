export type A2uiComponentName =
  | 'Text'
  | 'Heading'
  | 'BulletList'
  | 'TradeDecision'
  | 'ToolStatus'
  | 'StrategySummary'
  | 'StrategySetupForm'
  | 'InsightCards'
  | 'ButtonRow'
  | 'TopStockPicks'
  | 'CandidateDebate'
  | 'MonitorBatch'

export type A2uiStockPick = {
  symbol: string
  name?: string
  logoUrl?: string
  /** One-line thesis / why this name made the shortlist */
  recommendation?: string
  token?: string
  exchange?: string
  score?: number
}

export type A2uiButton = {
  label: string
  prompt: string
  variant?: 'primary' | 'secondary'
}

export type A2uiComponent = {
  id: string
  component: A2uiComponentName
  props: Record<string, unknown>
}

export type A2uiSurfaceMessage = {
  type: 'a2ui_surface' | 'a2ui_tool_log'
  messageId: string
  role: 'user' | 'agent'
  components: A2uiComponent[]
}

export type A2uiUserAction =
  | { type: 'send_prompt'; prompt: string }
  | { type: 'pick_symbol'; symbol: string }
  | { type: 'deploy_strategy'; payload: Record<string, unknown> }

export const A2UI_CATALOG: A2uiComponentName[] = [
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
]

export function isA2uiSurfaceMessage(value: unknown): value is A2uiSurfaceMessage {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return (
    (row.type === 'a2ui_surface' || row.type === 'a2ui_tool_log')
    && Array.isArray(row.components)
  )
}

const INTERACTIVE_COMPONENTS = new Set<A2uiComponentName>([
  'StrategySetupForm',
  'ButtonRow',
  'TopStockPicks',
])

const CHAT_BUBBLE_COMPONENTS = new Set<A2uiComponentName>([
  'Text',
  'Heading',
  'BulletList',
])

export function isTextChatBubble(surface: A2uiSurfaceMessage): boolean {
  if (surface.type === 'a2ui_tool_log') return false
  if (surface.role === 'user') return true
  if (!surface.components.length) return false
  return surface.components.every(component => CHAT_BUBBLE_COMPONENTS.has(component.component))
}

export function isChatSurface(surface: A2uiSurfaceMessage): boolean {
  if (surface.role === 'user') return true
  if (surface.type === 'a2ui_tool_log') return false
  return surface.components.some(component =>
    component.component !== 'ToolStatus',
  )
}

export function surfaceHasInteractiveControls(surface: A2uiSurfaceMessage): boolean {
  return surface.components.some(component => INTERACTIVE_COMPONENTS.has(component.component))
}
