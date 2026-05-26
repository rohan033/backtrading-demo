const FENCED_JSON_RE = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/gi
const INCOMPLETE_AI_ACTION_FENCE_RE = /```(?:json)?\s*\{[\s\S]*"ai_action"[\s\S]*$/i

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
