export type ChatReplySummary = {
  highlights: string[]
  lowlights: string[]
  cautions: string[]
}

const FENCED_JSON_RE = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/gi

const SECTION_HEADERS: Array<{ key: keyof ChatReplySummary; patterns: RegExp[] }> = [
  {
    key: 'highlights',
    patterns: [/^#{1,3}\s*highlights?\b/im, /^highlights?\s*:/im],
  },
  {
    key: 'lowlights',
    patterns: [/^#{1,3}\s*lowlights?\b/im, /^lowlights?\s*:/im, /^#{1,3}\s*risks?\b/im],
  },
  {
    key: 'cautions',
    patterns: [/^#{1,3}\s*cautions?\b/im, /^cautions?\s*:/im, /^#{1,3}\s*warnings?\b/im],
  },
]

function normalizeItems(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) {
    return value
      .map(item => String(item).trim())
      .filter(Boolean)
      .slice(0, 8)
  }
  const text = String(value).trim()
  return text ? [text] : []
}

function jsonContainsAiSummary(text: string): ChatReplySummary | null {
  try {
    const payload = JSON.parse(text.trim()) as Record<string, unknown>
    const block = payload.ai_summary
    if (!block || typeof block !== 'object') return null
    const summary = block as Record<string, unknown>
    const parsed: ChatReplySummary = {
      highlights: normalizeItems(summary.highlights),
      lowlights: normalizeItems(summary.lowlights),
      cautions: normalizeItems(summary.cautions),
    }
    if (!parsed.highlights.length && !parsed.lowlights.length && !parsed.cautions.length) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function parseBulletSection(lines: string[]): string[] {
  const items: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const bullet = trimmed.match(/^[-*•]\s+(.+)$/)
    if (bullet) {
      items.push(bullet[1].trim())
      continue
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      items.push(trimmed.replace(/^\d+\.\s+/, '').trim())
    }
  }
  return items.slice(0, 8)
}

function parseMarkdownSections(content: string): ChatReplySummary | null {
  const lines = content.split('\n')
  const sections: ChatReplySummary = {
    highlights: [],
    lowlights: [],
    cautions: [],
  }
  let current: keyof ChatReplySummary | null = null
  let buffer: string[] = []

  const flush = () => {
    if (!current || !buffer.length) return
    sections[current] = parseBulletSection(buffer)
    buffer = []
  }

  for (const line of lines) {
    let matched: keyof ChatReplySummary | null = null
    for (const spec of SECTION_HEADERS) {
      if (spec.patterns.some(pattern => pattern.test(line.trim()))) {
        matched = spec.key
        break
      }
    }
    if (matched) {
      flush()
      current = matched
      continue
    }
    if (current) buffer.push(line)
  }
  flush()

  if (!sections.highlights.length && !sections.lowlights.length && !sections.cautions.length) {
    return null
  }
  return sections
}

export function extractChatReplySummary(content: string): ChatReplySummary | null {
  for (const match of content.matchAll(FENCED_JSON_RE)) {
    const parsed = jsonContainsAiSummary(match[1])
    if (parsed) return parsed
  }

  const bareLines = content.split('\n')
  for (const line of bareLines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      const parsed = jsonContainsAiSummary(trimmed)
      if (parsed) return parsed
    }
  }

  return parseMarkdownSections(content)
}

export function stripAiSummaryBlocks(content: string, streaming = false): string {
  let text = content.replace(FENCED_JSON_RE, (match, jsonBody: string) =>
    jsonContainsAiSummary(jsonBody) ? '' : match,
  )

  const kept: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('{') && trimmed.endsWith('}') && jsonContainsAiSummary(trimmed)) {
      continue
    }
    kept.push(line)
  }
  text = kept.join('\n')

  const summary = extractChatReplySummary(content)
  if (summary) {
    for (const spec of SECTION_HEADERS) {
      for (const pattern of spec.patterns) {
        const match = text.match(pattern)
        if (!match || match.index == null) continue
        text = text.slice(0, match.index).trimEnd()
      }
    }
  }

  if (streaming) {
    const partialFence = /```(?:json)?\s*\{[\s\S]*"ai_summary"[\s\S]*$/i
    if (partialFence.test(text)) {
      const start = text.search(/```(?:json)?/i)
      if (start >= 0) text = text.slice(0, start).trimEnd()
    }
  }

  return text.replace(/\n{3,}/g, '\n\n').trim()
}

export function splitAssistantDisplayContent(
  content: string,
  streaming = false,
): { body: string; summary: ChatReplySummary | null } {
  const summary = streaming ? null : extractChatReplySummary(content)
  const body = stripAiSummaryBlocks(content, streaming)
  return { body, summary }
}

export function hasReplySummary(summary: ChatReplySummary | null | undefined): boolean {
  if (!summary) return false
  return Boolean(summary.highlights.length || summary.lowlights.length || summary.cautions.length)
}
