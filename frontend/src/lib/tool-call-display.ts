export type ToolCallStatus = 'running' | 'completed' | 'failed'

type ToolCallFields = {
  tool_name?: string
  tool_source?: string
  tool_status?: string
  args?: string
  input?: string
  arguments?: string
  path?: string
  command?: string
  parameters?: string
  content?: string
}

const MCP_TOOL_NAMES = new Set([
  'create_strategy', 'get_strategies', 'get_strategy', 'get_strategy_duplicate_template',
  'start_strategy', 'stop_strategy', 'unschedule_strategy', 'unschedule_all_strategies',
  'stop_all_strategies', 'get_engines', 'get_engine', 'get_engine_logs',
  'search_instruments', 'search_scrip', 'get_portfolio', 'get_etoro_positions',
  'get_etoro_orders', 'get_account_portfolio', 'get_historical_candles',
  'get_company_news', 'get_market_news', 'get_recommendation_trends', 'get_insider_transactions',
  'get_control_events', 'get_control_trades', 'get_control_orders',
  'get_event_sessions', 'get_event_session_events',
  'get_research_sessions', 'get_research_session', 'get_research_messages',
  'get_default_strategy_schedule', 'get_trading_day_options',
])

const WEB_TOOL_NAMES = new Set(['websearch', 'web_search', 'webfetch', 'web_fetch'])

const REPO_TOOL_NAMES = new Set([
  'read', 'grep', 'glob', 'glob_file_search', 'codebase_search', 'semanticsearch',
  'list_dir', 'read_file', 'readfile',
])

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

function normalizeToolName(rawName: string): string {
  return rawName.split('/').pop()?.trim().toLowerCase().replace(/-/g, '_') || 'tool'
}

export function classifyToolSource(toolName: string, explicit?: string): 'mcp' | 'web' | 'repo' | 'tool' {
  if (explicit === 'mcp' || explicit === 'web' || explicit === 'repo' || explicit === 'tool') {
    return explicit
  }
  const normalized = normalizeToolName(toolName)
  if (WEB_TOOL_NAMES.has(normalized)) return 'web'
  if (MCP_TOOL_NAMES.has(normalized) || normalized.startsWith('get_') || normalized.startsWith('search_')) {
    return 'mcp'
  }
  if (REPO_TOOL_NAMES.has(normalized)) return 'repo'
  return 'tool'
}

const SOURCE_PREFIX: Record<'mcp' | 'web' | 'repo' | 'tool', string> = {
  mcp: 'MCP',
  web: 'Web',
  repo: 'Repo',
  tool: 'Tool',
}

export function formatSessionToolLabel(toolName: string, toolSource?: string): string {
  const source = classifyToolSource(toolName, toolSource)
  return `${SOURCE_PREFIX[source]} · ${formatToolLabel(toolName)}`
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
    get_company_news: 'Company news',
    get_market_news: 'Market news',
    get_recommendation_trends: 'Analyst trends',
    get_insider_transactions: 'Insider transactions',
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
    read: 'Read file',
    grep: 'Search code',
    glob: 'Find files',
    list_dir: 'List directory',
    read_file: 'Read file',
    codebase_search: 'Code search',
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
