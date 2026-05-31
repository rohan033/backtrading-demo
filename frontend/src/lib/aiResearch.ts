export type AiResearchAction = {
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

export type AiResearchSession = {
  session_id: string
  title: string
  cursor_agent_id?: string | null
  interaction_mode: 'ask' | 'execute'
  status: string
  summary?: string | null
  actions?: AiResearchAction[]
  metadata?: Record<string, unknown> | null
  created_at: string
  updated_at: string
  last_message_at?: string | null
}

import type { ChatReplySummary } from '@/lib/aiReplySummary'
import { extractChatReplySummary } from '@/lib/aiReplySummary'
import { extractMediaAttachments, type ChatMediaAttachment } from '@/lib/workspaceMedia'

export type AiResearchMessage = {
  id: string
  session_id: string
  role: string
  content: string
  run_id?: string | null
  tool_name?: string | null
  tool_status?: string | null
  tool_detail?: string | null
  metadata?: { attachments?: ChatMediaAttachment[]; reply_summary?: ChatReplySummary } | null
  created_at: string
}

export type AiResearchMessagePage = {
  messages: AiResearchMessage[]
  has_more: boolean
  oldest_id: string | null
}

const MESSAGE_PAGE_SIZE = 50
const API = '/api/control/ai-research'

async function parseJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => null)
  if (!res.ok || !data?.status) {
    throw new Error(data?.detail || data?.message || `Request failed (${res.status})`)
  }
  return data.data as T
}

export async function listResearchSessions(): Promise<AiResearchSession[]> {
  const res = await fetch(`${API}/sessions`)
  return parseJson(res)
}

export async function createResearchSession(
  title = 'New research',
  interactionMode: 'ask' | 'execute' = 'ask',
): Promise<AiResearchSession> {
  const res = await fetch(`${API}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, interaction_mode: interactionMode }),
  })
  return parseJson(res)
}

export async function getResearchSession(sessionId: string): Promise<AiResearchSession> {
  const res = await fetch(`${API}/sessions/${encodeURIComponent(sessionId)}`)
  return parseJson(res)
}

export async function updateResearchSession(
  sessionId: string,
  patch: Partial<AiResearchSession>,
): Promise<AiResearchSession> {
  const res = await fetch(`${API}/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  return parseJson(res)
}

function normalizeMessagePage(data: AiResearchMessagePage | AiResearchMessage[]): AiResearchMessagePage {
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

export async function listResearchMessages(
  sessionId: string,
  options: { limit?: number; before?: string | null } = {},
): Promise<AiResearchMessagePage> {
  const params = new URLSearchParams()
  params.set('limit', String(options.limit ?? MESSAGE_PAGE_SIZE))
  if (options.before) params.set('before', options.before)
  const res = await fetch(`${API}/sessions/${encodeURIComponent(sessionId)}/messages?${params}`)
  const data = await parseJson<AiResearchMessagePage | AiResearchMessage[]>(res)
  return normalizeMessagePage(data)
}

export { MESSAGE_PAGE_SIZE }

export async function upsertResearchAction(
  sessionId: string,
  action: Partial<AiResearchAction> & { type: string; title: string },
): Promise<AiResearchSession> {
  const res = await fetch(`${API}/sessions/${encodeURIComponent(sessionId)}/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(action),
  })
  return parseJson(res)
}

export function messageToChatRow(message: AiResearchMessage) {
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
