import { useMemo } from 'react'

import { Loader2 } from 'lucide-react'

import type { AgentTurn } from '@/hooks/useTradingSessionEvents'
import type { TradingSessionEvent } from '@/lib/tradingSessions'
import { statusEvents } from './TradingSessionStatusDrawer'
import type { ToolCallStatus } from '@/lib/tool-call-display'

type Props = {
  events: TradingSessionEvent[]
  turns: AgentTurn[]
  agentRunning: boolean
  onOpenStatusDrawer?: () => void
}

const AGENT_INLINE_TYPES = new Set([
  'agent_run_started',
  'agent_run_finished',
  'agent_thinking',
  'agent_tool_call',
  'agent_text',
])

function normalizeToolStatus(raw: unknown): ToolCallStatus {
  const s = String(raw || 'running').toLowerCase()
  if (s.includes('fail') || s === 'error') return 'failed'
  if (s.includes('complete') || s === 'success' || s === 'done') return 'completed'
  return 'running'
}

function SessionToolCallRow({
  label,
  status,
  detail,
}: {
  label: string
  status: ToolCallStatus
  detail?: string
}) {
  return (
    <div className={`am-ts-tool-hint am-ts-tool-hint--${status}`} title={detail ? `${label} · ${detail}` : label}>
      <span className="am-ts-tool-hint__icon" aria-hidden>
        {status === 'running' ? (
          <Loader2 className="am-ts-tool-hint__spin" />
        ) : status === 'failed' ? (
          '×'
        ) : (
          '✓'
        )}
      </span>
      <span className="am-ts-tool-hint__text">
        <span className="am-ts-tool-hint__label">{label}</span>
        {detail ? <span className="am-ts-tool-hint__detail">{detail}</span> : null}
      </span>
    </div>
  )
}

function AgentTurnBlock({ turn, running }: { turn: AgentTurn; running: boolean }) {
  const fullThinking = useMemo(() => {
    const fromThinking = turn.thinking.map(e => String(e.payload?.message || '')).join('')
    const fromText = turn.texts.map(e => String(e.payload?.text || '')).join('\n')
    return (fromText || fromThinking).trim()
  }, [turn.thinking, turn.texts])

  const thinkingPreview = fullThinking.slice(0, 80)

  return (
    <div className="am-ts-turn">
      <div className="am-ts-turn__head">
        <span className="am-ts-turn__title">{turn.state || 'agent'} · run</span>
        {running && !turn.finished ? (
          <span className="am-ts-thinking">Thinking…</span>
        ) : null}
      </div>

      {turn.tools.length > 0 ? (
        <details className="am-ts-collapsible" open={running && !turn.finished}>
          <summary>
            Tool calls ({turn.tools.length})
            <span className="am-ts-collapsible__preview">
              {String(turn.tools[turn.tools.length - 1]?.payload?.tool_name || '')}
            </span>
          </summary>
          <div className="am-ts-collapsible__body">
            {turn.tools.map(tool => (
              <SessionToolCallRow
                key={tool.id}
                label={String(tool.payload?.tool_name || 'tool')}
                status={normalizeToolStatus(tool.payload?.tool_status)}
                detail={String(tool.payload?.detail || '')}
              />
            ))}
          </div>
        </details>
      ) : null}

      {fullThinking ? (
        <details className="am-ts-collapsible">
          <summary>
            Thinking trace
            <span className="am-ts-collapsible__preview">{thinkingPreview}</span>
          </summary>
          <pre className="am-ts-thinking-trace">{fullThinking}</pre>
        </details>
      ) : null}
    </div>
  )
}

export default function TradingSessionActivityFeed({
  events,
  turns,
  agentRunning,
  onOpenStatusDrawer,
}: Props) {
  const turnByRunId = useMemo(() => {
    const map = new Map<string, AgentTurn>()
    for (const turn of turns) map.set(turn.runId, turn)
    return map
  }, [turns])

  const statusCount = useMemo(() => statusEvents(events).length, [events])
  const renderedRuns = new Set<string>()
  const hasAgentActivity = turns.length > 0 || agentRunning

  return (
    <div className="am-ts-feed">
      <div className="am-ts-feed__toolbar">
        <span className="am-ts-feed__title">Agent</span>
        {onOpenStatusDrawer ? (
          <button
            type="button"
            className="am-ts-log-btn"
            onClick={onOpenStatusDrawer}
            title="Session status log"
          >
            Log{statusCount ? ` · ${statusCount}` : ''}
          </button>
        ) : null}
      </div>
      <div className="am-ts-feed__body">
        {!hasAgentActivity && !agentRunning ? (
          <div className="am-empty-note">Waiting for agent activity…</div>
        ) : null}
        {events.map(event => {
          if (!AGENT_INLINE_TYPES.has(event.event_type)) return null
          if (event.event_type === 'agent_run_started') {
            const runId = String(event.payload?.run_id || event.payload?.runId || '')
            if (renderedRuns.has(runId)) return null
            renderedRuns.add(runId)
            const turn = turnByRunId.get(runId)
            if (!turn) return null
            const running = agentRunning && !turn.finished
            return <AgentTurnBlock key={`turn-${runId}`} turn={turn} running={running} />
          }
          return null
        })}
        {agentRunning && turns.every(t => t.finished) ? (
          <div className="am-ts-turn">
            <span className="am-ts-thinking">Thinking…</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
