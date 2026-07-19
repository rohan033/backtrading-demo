import type { ChatReplySummary } from '@/lib/aiReplySummary'
import { extractChatReplySummary } from '@/lib/aiReplySummary'
import { extractMediaAttachments, type ChatMediaAttachment } from '@/lib/workspaceMedia'

export type AgentUiPhase = 'chat' | 'trading'

export type AgentThreadFocus = {
  symbol?: string
  token?: string | null
  exchange?: string
  broker?: string
  account_env?: string
  close_price?: number | null
  long_percent?: number | null
  short_percent?: number | null
  initial_threshold?: number | null
  max_available_capital?: number | null
  execution_id?: string | null
}

export type AgentThreadMetadata = {
  product?: string
  ui_phase?: AgentUiPhase
  focus?: AgentThreadFocus
  broker?: 'angel' | 'etoro' | string
  account_env?: 'live' | 'demo' | string
  web_search_enabled?: boolean
  monitor_state?: 'active' | 'completed' | 'idle' | string
  monitor_active?: boolean
  monitor_user_enabled?: boolean
}

export type AgentTradeLog = {
  id: string
  session_id: string
  symbol?: string | null
  broker?: string | null
  account_env?: string | null
  outcome?: string | null
  pnl?: number | null
  pnl_pct?: number | null
  entry_price?: number | null
  exit_price?: number | null
  capital?: number | null
  position_id?: string | null
  execution_id?: string | null
  notes?: string | null
  metadata?: Record<string, unknown>
  created_at: string
}

export type AgentThreadAction = {
  id: string
  type: string
  title: string
  status?: string
  payload?: Record<string, unknown>
  sources?: unknown[]
  message_id?: string | null
  created_at?: string
  updated_at?: string
}

export type AgentThread = {
  thread_id: string
  title: string
  status: string
  summary?: string | null
  actions?: AgentThreadAction[]
  metadata?: AgentThreadMetadata | Record<string, unknown> | null
  cursor_agent_id?: string | null
  created_at: string
  updated_at: string
  last_message_at?: string | null
}

export type AgentThreadMessageMetadata = {
  attachments?: ChatMediaAttachment[]
  reply_summary?: ChatReplySummary
  source?: string
  monitor_batch?: {
    symbol?: string
    eventCount?: number
    items?: Array<Record<string, unknown>>
  }
}

export type AgentThreadMessage = {
  id: string
  session_id: string
  role: string
  content: string
  run_id?: string | null
  tool_name?: string | null
  tool_status?: string | null
  tool_detail?: string | null
  metadata?: AgentThreadMessageMetadata | null
  created_at: string
}

export type AgentThreadMessagePage = {
  messages: AgentThreadMessage[]
  has_more: boolean
  oldest_id: string | null
}

export const AGENT_THREAD_MESSAGE_PAGE_SIZE = 200

const API = '/api/control/agent'

async function parseJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => null)
  if (!res.ok || !data?.status) {
    throw new Error(data?.detail || data?.message || `Request failed (${res.status})`)
  }
  return data.data as T
}

function normalizeMessagePage(data: AgentThreadMessagePage | AgentThreadMessage[]): AgentThreadMessagePage {
  if (Array.isArray(data)) {
    return {
      messages: data,
      has_more: false,
      oldest_id: data[0]?.id ?? null,
    }
  }
  const messages = data.messages ?? []
  return {
    messages,
    has_more: Boolean(data.has_more),
    oldest_id: data.oldest_id ?? messages[0]?.id ?? null,
  }
}

export async function listAgentThreads(): Promise<AgentThread[]> {
  const res = await fetch(`${API}/threads`)
  return parseJson(res)
}

export async function createAgentThread(title = 'New thread'): Promise<AgentThread> {
  const res = await fetch(`${API}/threads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  return parseJson(res)
}

export async function getAgentThread(threadId: string): Promise<AgentThread> {
  const res = await fetch(`${API}/threads/${encodeURIComponent(threadId)}`)
  return parseJson(res)
}

export async function listAgentThreadMessages(
  threadId: string,
  options: { limit?: number; before?: string | null } = {},
): Promise<AgentThreadMessagePage> {
  const params = new URLSearchParams()
  params.set('limit', String(options.limit ?? AGENT_THREAD_MESSAGE_PAGE_SIZE))
  if (options.before) params.set('before', options.before)
  const res = await fetch(`${API}/threads/${encodeURIComponent(threadId)}/messages?${params}`)
  const data = await parseJson<AgentThreadMessagePage | AgentThreadMessage[]>(res)
  return normalizeMessagePage(data)
}

/** Load full thread history (paginated) for hydration after refresh. */
export async function listAllAgentThreadMessages(
  threadId: string,
  options: { pageSize?: number; maxMessages?: number } = {},
): Promise<AgentThreadMessage[]> {
  const pageSize = options.pageSize ?? AGENT_THREAD_MESSAGE_PAGE_SIZE
  const maxMessages = options.maxMessages ?? 500
  let page = await listAgentThreadMessages(threadId, { limit: pageSize })
  let all = [...page.messages]

  while (page.has_more && page.oldest_id && all.length < maxMessages) {
    page = await listAgentThreadMessages(threadId, { limit: pageSize, before: page.oldest_id })
    if (!page.messages.length) break
    all = [...page.messages, ...all]
  }

  return all.slice(-maxMessages)
}

export function getThreadUiPhase(thread: AgentThread | null): AgentUiPhase {
  const meta = (thread?.metadata || {}) as AgentThreadMetadata
  return meta.ui_phase === 'trading' ? 'trading' : 'chat'
}

export function getThreadFocus(thread: AgentThread | null): AgentThreadFocus | null {
  const meta = (thread?.metadata || {}) as AgentThreadMetadata
  return meta.focus && meta.focus.symbol ? meta.focus : null
}

export function getThreadBrokerContext(thread: AgentThread | null): {
  broker: 'angel' | 'etoro'
  accountEnv: 'live' | 'demo'
} {
  const meta = (thread?.metadata || {}) as AgentThreadMetadata
  const broker = (meta.broker || 'angel').toLowerCase() === 'etoro' ? 'etoro' : 'angel'
  const accountEnv = (meta.account_env || (broker === 'etoro' ? 'demo' : 'live')) as 'live' | 'demo'
  return { broker, accountEnv }
}

export async function updateAgentThread(
  threadId: string,
  patch: {
    title?: string
    interaction_mode?: 'ask' | 'execute'
    metadata?: AgentThreadMetadata | Record<string, unknown>
  },
): Promise<AgentThread> {
  const res = await fetch(`${API}/threads/${encodeURIComponent(threadId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  return parseJson(res)
}

export async function listAgentTradeLogs(
  threadId: string,
  options: {
    limit?: number
    startDate?: string
    endDate?: string
  } = {},
): Promise<AgentTradeLog[]> {
  const params = new URLSearchParams()
  params.set('limit', String(options.limit ?? 500))
  if (options.startDate) params.set('start_date', options.startDate)
  if (options.endDate) params.set('end_date', options.endDate)
  const qs = params.toString()
  const res = await fetch(`${API}/threads/${encodeURIComponent(threadId)}/pnl?${qs}`)
  return parseJson(res)
}

export function isMonitorCompleted(thread: AgentThread | null): boolean {
  const meta = (thread?.metadata || {}) as AgentThreadMetadata
  return meta.monitor_state === 'completed'
}

export function messageToThreadChatRow(message: AgentThreadMessage) {
  const role = message.role === 'assistant' || message.role === 'tool' || message.role === 'system'
    ? message.role
    : 'user'
  const storedAttachments = message.metadata?.attachments
  const inferredAttachments =
    role === 'assistant' ? extractMediaAttachments(message.content) : []
  const attachments = [...(storedAttachments || []), ...inferredAttachments].filter(
    (item, index, list) => list.findIndex(row => row.path === item.path) === index,
  )

  return {
    id: message.id,
    role,
    content: message.content,
    toolName: message.tool_name || undefined,
    toolStatus: message.tool_status || undefined,
    toolDetail: message.tool_detail || undefined,
    attachments: attachments.length ? attachments : undefined,
    replySummary:
      message.metadata?.reply_summary ??
      (role === 'assistant' ? extractChatReplySummary(message.content) ?? undefined : undefined),
  }
}
