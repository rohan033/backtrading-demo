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
