const FENCED_JSON_RE = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/gi
const INCOMPLETE_AI_ACTION_FENCE_RE = /```(?:json)?\s*\{[\s\S]*"ai_action"[\s\S]*$/i

export type AiActionBlock = {
  type: string
  title: string
  payload?: Record<string, unknown>
  sources?: unknown[]
  status?: string
  id?: string
}

function parseAiActionPayload(text: string): AiActionBlock | null {
  try {
    const payload = JSON.parse(text.trim()) as unknown
    if (typeof payload !== 'object' || payload === null) return null
    const record = payload as Record<string, unknown>
    const action = record.ai_action
    if (typeof action === 'object' && action !== null) {
      const row = action as Record<string, unknown>
      return {
        type: String(row.type || 'note'),
        title: String(row.title || 'Suggested action'),
        payload: (row.payload as Record<string, unknown>) || {},
        sources: Array.isArray(row.sources) ? row.sources : [],
        status: row.status ? String(row.status) : undefined,
        id: row.id ? String(row.id) : undefined,
      }
    }
    if (record.type) {
      return {
        type: String(record.type),
        title: String(record.title || 'Suggested action'),
        payload: (record.payload as Record<string, unknown>) || {},
        sources: Array.isArray(record.sources) ? record.sources : [],
        status: record.status ? String(record.status) : undefined,
        id: record.id ? String(record.id) : undefined,
      }
    }
  } catch {
    return null
  }
  return null
}

export function extractAiActions(content: string, streaming = false): AiActionBlock[] {
  if (streaming) return []
  const actions: AiActionBlock[] = []
  const seen = new Set<string>()

  for (const match of content.matchAll(FENCED_JSON_RE)) {
    const action = parseAiActionPayload(match[1])
    if (!action) continue
    const key = `${action.type}:${action.title}:${JSON.stringify(action.payload || {})}`
    if (seen.has(key)) continue
    seen.add(key)
    actions.push(action)
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue
    const action = parseAiActionPayload(trimmed)
    if (!action) continue
    const key = `${action.type}:${action.title}:${JSON.stringify(action.payload || {})}`
    if (seen.has(key)) continue
    seen.add(key)
    actions.push(action)
  }

  return actions
}

function jsonContainsAiAction(text: string): boolean {
  try {
    const payload = JSON.parse(text.trim()) as unknown
    return typeof payload === 'object' && payload !== null && 'ai_action' in payload
  } catch {
    return false
  }
}

function stripBareAiActionLines(content: string): string {
  const kept: string[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('{') && trimmed.endsWith('}') && jsonContainsAiAction(trimmed)) {
      continue
    }
    kept.push(line)
  }
  return kept.join('\n')
}

function stripIncompleteAiActionFence(content: string): string {
  if (!INCOMPLETE_AI_ACTION_FENCE_RE.test(content)) return content
  const start = content.search(/```(?:json)?/i)
  return start >= 0 ? content.slice(0, start).trimEnd() : content
}

export function stripAiActionBlocks(content: string, streaming = false): string {
  let text = content.replace(FENCED_JSON_RE, (match, jsonBody: string) =>
    jsonContainsAiAction(jsonBody) ? '' : match,
  )
  text = stripBareAiActionLines(text)
  if (streaming) {
    text = stripIncompleteAiActionFence(text)
  }
  return text.replace(/\n{3,}/g, '\n\n').trim()
}
