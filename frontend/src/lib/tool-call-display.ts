export type ToolCallStatus = 'running' | 'completed' | 'failed'

type ToolCallFields = {
  tool_name?: string
  tool_status?: string
  args?: string
  input?: string
  arguments?: string
  path?: string
  command?: string
  parameters?: string
  content?: string
}

export function normalizeToolStatus(raw?: string): ToolCallStatus {
  const status = (raw || 'running').toLowerCase()
  if (['completed', 'complete', 'success', 'succeeded', 'done'].includes(status)) {
    return 'completed'
  }
  if (['failed', 'error', 'cancelled', 'canceled', 'blocked'].includes(status)) {
    return 'failed'
  }
  return 'running'
}

export function formatToolLabel(rawName: string): string {
  const base = rawName.split('/').pop()?.trim() || rawName.trim() || 'Tool'
  const normalized = base.toLowerCase().replace(/-/g, '_')
  if (normalized === 'websearch' || normalized === 'web_search') return 'Web search'
  if (normalized === 'webfetch' || normalized === 'web_fetch') return 'Web fetch'
  const mcpLabels: Record<string, string> = {
    create_strategy: 'Create strategy',
    get_strategies: 'Get strategies',
    get_strategy: 'Get strategy',
    get_strategy_duplicate_template: 'Duplicate template',
    start_strategy: 'Start strategy',
    stop_strategy: 'Stop strategy',
    unschedule_strategy: 'Unschedule strategy',
    unschedule_all_strategies: 'Unschedule all',
    stop_all_strategies: 'Stop all strategies',
    get_engines: 'Get engines',
    get_engine: 'Get engine',
    get_engine_logs: 'Get engine logs',
    search_instruments: 'Search instruments',
    search_scrip: 'Search scrip',
    get_portfolio: 'Get portfolio',
    get_etoro_positions: 'Get eToro positions',
    get_etoro_orders: 'Get eToro orders',
    get_account_portfolio: 'Get account portfolio',
    get_historical_candles: 'Get historical candles',
    get_control_events: 'Get events',
    get_control_trades: 'Get trades',
    get_control_orders: 'Get orders',
    get_event_sessions: 'Get event sessions',
    get_event_session_events: 'Get session events',
    get_research_sessions: 'Get research sessions',
    get_research_session: 'Get research session',
    get_research_messages: 'Get research messages',
    get_default_strategy_schedule: 'Default schedule',
    get_trading_day_options: 'Trading day options',
  }
  if (mcpLabels[normalized]) return mcpLabels[normalized]
  const stripped = base
    .replace(/_api_control.*$/i, '')
    .replace(/_?(get|post|put|patch|delete)$/i, '')
  const words = stripped.split('_').filter(Boolean)
  if (!words.length) return base
  return words.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

export function summarizeToolDetail(event: ToolCallFields): string | undefined {
  const raw =
    event.path ||
    event.command ||
    event.args ||
    event.input ||
    event.arguments ||
    event.parameters ||
    event.content

  if (!raw) return undefined

  const text = raw.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  if (text.length <= 72) return text
  return `${text.slice(0, 69)}…`
}
