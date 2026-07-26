import type {
  AgenticSessionEvent,
  AgenticThinkingBlock,
} from '@/lib/agenticSessions'
import { humanizeAgent } from './shared'

export type LogEntryKind = 'agent' | 'thinking' | 'trade' | 'system'

export type LogEntry = {
  id: string
  kind: LogEntryKind
  tone: string
  ts: string
  source: string
  agent: string
  ticker: string | null
  oneline: string
  data: string
  confidence: number | null
  streaming: boolean
}

/** Strip markdown / JSON / A2UI noise down to readable plain text. */
export function cleanText(value: string): string {
  let text = String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#]+/g, '')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim()

  if (/^(running|finished|started|complete|completed|done|idle)$/i.test(text)) {
    return ''
  }
  if (/^RUNNING/i.test(text) && text.length > 7 && /[A-Za-z]/.test(text.charAt(7))) {
    text = text.slice(7).trimStart()
  }
  if (/FINISHED$/i.test(text) && text.length > 8) {
    text = text.slice(0, -8).trimEnd()
  }
  if (/\b(checking|reading|searching).*(repo|repository|codebase|orchestrator logic)\b/i.test(text)) {
    return ''
  }
  return text
}

function isJunkEvent(event: AgenticSessionEvent, text: string): boolean {
  const meta = event.meta || {}
  if (event.text === 'agent_a2ui_surface' || meta.type === 'a2ui_surface') return true
  if (!text && !meta.oneline && !meta.data) return true
  if (/^(a2ui|tool_(call|result)|\{["']?(type|component|children)["']?)/i.test(text)) return true
  if (/^[[{].*[\]}]$/.test(text) && /"(args|tool|type|payload|component)"/i.test(text)) return true
  return false
}

// Raw event types folded into the streaming thinking blocks / dropped as noise.
const SKIP_TYPES = new Set(['thinking', 'agent_event'])

const TRADE_TYPES = new Set(['entry', 'exit', 'trim', 'state_change'])
const AGENT_TYPES = new Set(['agent_response', 'subagent', 'orchestrator'])

function toneForType(type: string): string {
  if (type === 'entry') return 'entry'
  if (type === 'exit') return 'exit'
  if (type === 'trim') return 'trim'
  if (type === 'error') return 'error'
  if (type === 'stop' || type === 'risk_action') return 'risk'
  if (type === 'suggestion') return 'suggestion'
  if (type === 'reconciliation') return 'recon'
  if (AGENT_TYPES.has(type)) return 'agent'
  return 'info'
}

function agentSource(event: AgenticSessionEvent): string {
  const meta = event.meta || {}
  return String(meta.agent || meta.provenance || event.type || 'system')
}

function agentName(event: AgenticSessionEvent): string {
  const raw = agentSource(event)
  if (isOrchestratorSource(raw) && raw !== 'main_orchestrator' && raw !== 'orchestrator') {
    return 'Main Orchestrator'
  }
  if (raw) return humanizeAgent(raw)
  return humanizeAgent(String(event.type || 'system'))
}

function entryFromEvent(event: AgenticSessionEvent): LogEntry | null {
  const meta = event.meta || {}
  const text = cleanText(event.text || '')
  if (isJunkEvent(event, text)) return null
  const type = String(event.type || 'info')
  const oneline = cleanText(String(meta.oneline || '')) || text.split('\n')[0] || text
  const data = cleanText(String(meta.data || '')) || text
  const kind: LogEntryKind = TRADE_TYPES.has(type)
    ? 'trade'
    : AGENT_TYPES.has(type)
      ? 'agent'
      : 'system'
  return {
    id: `e${event.id}`,
    kind,
    tone: toneForType(type),
    ts: event.ts,
    source: agentSource(event),
    agent: agentName(event),
    ticker: event.ticker,
    oneline: oneline || data || agentName(event),
    data,
    confidence: typeof meta.confidence === 'number' ? meta.confidence : null,
    streaming: false,
  }
}

function isThinkingPlaceholder(value: string): boolean {
  return /^thinking…?\.?$/i.test(value.trim())
}

/** Avoid showing a broken tail fragment when the summary line is complete. */
function thinkingBodyText(text: string, summary: string, done: boolean): string {
  if (!done) return text
  if (!text) return summary
  if (text === summary) return text
  if (summary.endsWith(text)) return summary
  if (text.length < summary.length * 0.6) return summary
  return text
}

function entryFromThinking(block: AgenticThinkingBlock): LogEntry | null {
  const text = cleanText(block.text || '')
  const rawOneline = cleanText(block.oneline || '')
  const summary = block.done
    ? (!isThinkingPlaceholder(rawOneline) && rawOneline) || text.split('\n')[0] || 'Reasoned'
    : 'Thinking…'
  const data = thinkingBodyText(text, summary, block.done)
  if (!data && !summary) return null
  if (block.done && !data && summary === 'Reasoned') return null
  return {
    id: `t${block.run_id}`,
    kind: 'thinking',
    tone: 'thinking',
    ts: block.updated_at || block.started_at,
    source: String(block.agent || 'agent'),
    agent: humanizeAgent(block.agent || 'agent'),
    ticker: block.ticker,
    oneline: summary,
    data,
    confidence: null,
    streaming: !block.done,
  }
}
export function buildLog(
  events: AgenticSessionEvent[],
  thinking: AgenticThinkingBlock[],
  limit = 80,
): LogEntry[] {
  const entries: LogEntry[] = []
  for (const event of events) {
    if (SKIP_TYPES.has(String(event.type))) continue
    const entry = entryFromEvent(event)
    if (entry) entries.push(entry)
  }
  for (const block of thinking) {
    const entry = entryFromThinking(block)
    if (entry) entries.push(entry)
  }
  entries.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
  return entries.slice(0, limit)
}

export function isOrchestratorSource(source: string): boolean {
  const key = String(source || '').toLowerCase().replace(/\s+/g, '_')
  if (key === 'main_orchestrator' || key === 'orchestrator') return true
  // Execution events are orchestrator-owned (session engine acts on orchestrator gate).
  if (key === 'entry' || key === 'exit' || key === 'trim' || key === 'playbook') return true
  return false
}

export function splitLogEntries(entries: LogEntry[]): {
  orchestrator: LogEntry[]
  subagents: LogEntry[]
} {
  const orchestrator: LogEntry[] = []
  const subagents: LogEntry[] = []
  for (const entry of entries) {
    if (isOrchestratorSource(entry.source)) orchestrator.push(entry)
    else subagents.push(entry)
  }
  return { orchestrator, subagents }
}
