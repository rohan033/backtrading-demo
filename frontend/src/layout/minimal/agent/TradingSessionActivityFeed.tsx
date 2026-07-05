import { useMemo } from 'react'

import { Loader2 } from 'lucide-react'

import { A2uiRenderer } from '@/components/agent/A2uiRenderer'
import type { AgentTurn } from '@/hooks/useTradingSessionEvents'
import type { TradingSessionEvent } from '@/lib/tradingSessions'
import { surfaceFromSessionEvent } from '@/lib/tradingSessionSurfaces'
import type { ToolCallStatus } from '@/lib/tool-call-display'

type Props = {
  events: TradingSessionEvent[]
  turns: AgentTurn[]
  agentRunning: boolean
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

function EventRow({ event }: { event: TradingSessionEvent }) {
  const p = event.payload || {}
  const a2uiSurface = surfaceFromSessionEvent(event)

  if (a2uiSurface && (event.event_type === 'agent_a2ui_surface' || event.event_type === 'agent_picks')) {
    if (a2uiSurface.components.some(c => c.component === 'TopStockPicks')) {
      return null
    }
    return (
      <div className="am-ts-event am-ts-event--a2ui">
        <A2uiRenderer surface={a2uiSurface} />
      </div>
    )
  }

  if (event.event_type === 'state_entered') {
    const from = p.from_state ? `${String(p.from_state)} → ` : ''
    return (
      <div className="am-ts-event am-ts-event--state">
        <span className="am-ts-event__label">State</span>
        <span>{from}{String(p.state)}</span>
        {p.reason ? <span className="am-ts-event__meta">{String(p.reason)}</span> : null}
      </div>
    )
  }

  if (event.event_type === 'symbol_resolved') {
    return (
      <div className="am-ts-event am-ts-event--ok">
        <span className="am-ts-event__label">Symbol</span>
        <span>{String(p.symbol)} · {String(p.token)} · {String(p.exchange)}</span>
      </div>
    )
  }

  if (event.event_type === 'top_pick_selected') {
    return (
      <div className="am-ts-event am-ts-event--ok">
        <span className="am-ts-event__label">Top pick</span>
        <span>{String(p.symbol)}</span>
        {p.recommendation ? <span className="am-ts-event__meta">{String(p.recommendation)}</span> : null}
      </div>
    )
  }

  if (event.event_type === 'session_stopped' || event.event_type === 'agent_explore_failed') {
    return (
      <div className="am-ts-event am-ts-event--stop">
        <span className="am-ts-event__label">{event.event_type === 'session_stopped' ? 'Stopped' : 'Failed'}</span>
        <span>{String(p.stopped_reason || p.reason || '')}</span>
      </div>
    )
  }

  if (event.event_type === 'session_created' || event.event_type === 'agent_explore_started') {
    return (
      <div className="am-ts-event">
        <span className="am-ts-event__label">{event.event_type === 'session_created' ? 'Created' : 'Explore'}</span>
        <span>Session started</span>
      </div>
    )
  }

  return (
    <div className="am-ts-event">
      <span className="am-ts-event__label">{event.event_type}</span>
      <span className="am-ts-event__meta">{JSON.stringify(p).slice(0, 120)}</span>
    </div>
  )
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
}: Props) {
  const turnByRunId = useMemo(() => {
    const map = new Map<string, AgentTurn>()
    for (const turn of turns) map.set(turn.runId, turn)
    return map
  }, [turns])

  const renderedRuns = new Set<string>()

  return (
    <div className="am-ts-feed">
      <div className="am-ts-feed__toolbar">
        <span className="am-ts-feed__title">Activity</span>
      </div>
      <div className="am-ts-feed__body">
        {!events.length && !agentRunning ? (
          <div className="am-empty-note">No activity yet.</div>
        ) : null}
        {events.map(event => {
          if (AGENT_INLINE_TYPES.has(event.event_type)) {
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
          }
          if (event.event_type === 'agent_picks') return null
          if (
            event.event_type === 'agent_a2ui_surface'
            && Array.isArray(event.payload?.components)
            && event.payload.components.some((c: { component?: string }) => c.component === 'TopStockPicks')
          ) {
            return null
          }
          return <EventRow key={event.id} event={event} />
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
