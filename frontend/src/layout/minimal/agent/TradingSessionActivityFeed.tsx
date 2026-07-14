import { useMemo } from 'react'

import { Loader2 } from 'lucide-react'

import { A2uiRenderer } from '@/components/agent/A2uiRenderer'
import type { AgentTurn } from '@/hooks/useTradingSessionEvents'
import type { TradingSessionEvent } from '@/lib/tradingSessions'
import {
  sessionA2uiSurfaces,
  sessionSurfacesForRun,
  stripAgentTextFences,
} from '@/lib/tradingSessionSurfaces'
import { statusEvents } from './TradingSessionStatusDrawer'
import TradingSessionInstructionBar from './TradingSessionInstructionBar'
import { formatSessionToolLabel, normalizeToolStatus, summarizeToolDetail, extractMcpToolArgs, type ToolCallFields, type ToolCallStatus } from '@/lib/tool-call-display'
import { ToolCallMcpArgsAccordion } from '@/components/ui/tool-call-mcp-args'
import '@/components/ui/tool-call-mcp-args.css'
import type { TradingSession } from '@/lib/tradingSessions'

type Props = {
  events: TradingSessionEvent[]
  turns: AgentTurn[]
  agentRunning: boolean
  sessionStopped?: boolean
  onOpenStatusDrawer?: () => void
  session?: TradingSession | null
  onSessionUpdate?: (session: TradingSession) => void
}

function effectiveToolStatus(raw: string | undefined, inactive: boolean): ToolCallStatus {
  const status = normalizeToolStatus(raw)
  if (inactive && status === 'running') return 'failed'
  return status
}

const AGENT_INLINE_TYPES = new Set([
  'agent_run_started',
  'agent_run_finished',
  'agent_thinking',
  'agent_tool_call',
  'agent_text',
])

function SessionToolCallRow({
  label,
  status,
  detail,
  toolName,
  toolSource,
  event,
}: {
  label: string
  status: ReturnType<typeof normalizeToolStatus>
  detail?: string
  toolName: string
  toolSource?: string
  event?: ToolCallFields
}) {
  const showArgsAccordion = Boolean(extractMcpToolArgs(event))
  return (
    <div className="am-ts-tool-row">
      <div className={`am-ts-tool-hint am-ts-tool-hint--${status}`} title={detail && !showArgsAccordion ? `${label} · ${detail}` : label}>
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
          {detail && !showArgsAccordion ? <span className="am-ts-tool-hint__detail">{detail}</span> : null}
        </span>
      </div>
      <ToolCallMcpArgsAccordion
        toolName={toolName}
        toolSource={toolSource}
        event={event}
        className="am-ts-tool-args"
      />
    </div>
  )
}

function AgentTurnBlock({
  turn,
  running,
  sessionStopped,
  events,
}: {
  turn: AgentTurn
  running: boolean
  sessionStopped: boolean
  events: TradingSessionEvent[]
}) {
  const turnSurfaces = useMemo(
    () => sessionSurfacesForRun(events, turn.runId),
    [events, turn.runId],
  )

  const prosePreview = useMemo(() => {
    const fromThinking = turn.thinking.map(e => String(e.payload?.message || '')).join('')
    const fromText = turn.texts.map(e => String(e.payload?.text || '')).join('\n')
    const raw = stripAgentTextFences(fromText || fromThinking).trim()
    return raw.slice(0, 120)
  }, [turn.thinking, turn.texts])

  const hasProse = prosePreview.length > 0 && turnSurfaces.length === 0
  const turnInactive = sessionStopped || Boolean(turn.finished)

  return (
    <div className="am-ts-turn">
      <div className="am-ts-turn__head">
        <span className="am-ts-turn__title">{turn.state || 'agent'} · run</span>
        {running && !turn.finished ? (
          <span className="am-ts-thinking">Thinking…</span>
        ) : null}
      </div>

      {turnSurfaces.length > 0 ? (
        <div className="am-ts-turn__surfaces">
          {turnSurfaces.map(surface => (
            <div key={surface.messageId} className="am-ts-surface">
              <A2uiRenderer surface={surface} autonomousSession />
            </div>
          ))}
        </div>
      ) : null}

      {turn.tools.length > 0 ? (
        <details className="am-ts-collapsible" open={running && !turn.finished}>
          <summary>
            Tool calls ({turn.tools.length})
            <span className="am-ts-collapsible__preview">
              {formatSessionToolLabel(
                String(turn.tools[turn.tools.length - 1]?.payload?.tool_name || 'tool'),
                String(turn.tools[turn.tools.length - 1]?.payload?.tool_source || ''),
                turn.tools[turn.tools.length - 1]?.payload as Record<string, unknown>,
              )}
            </span>
          </summary>
          <div className="am-ts-collapsible__body">
            {turn.tools.map(tool => (
              <SessionToolCallRow
                key={tool.id}
                label={formatSessionToolLabel(
                  String(tool.payload?.tool_name || 'tool'),
                  String(tool.payload?.tool_source || ''),
                  tool.payload as ToolCallFields,
                )}
                status={effectiveToolStatus(String(tool.payload?.tool_status), turnInactive)}
                detail={summarizeToolDetail(tool.payload as ToolCallFields)}
                toolName={String(tool.payload?.tool_name || 'tool')}
                toolSource={String(tool.payload?.tool_source || '')}
                event={tool.payload as ToolCallFields}
              />
            ))}
          </div>
        </details>
      ) : null}

      {hasProse ? (
        <details className="am-ts-collapsible">
          <summary>
            Agent notes
            <span className="am-ts-collapsible__preview">{prosePreview}</span>
          </summary>
          <pre className="am-ts-thinking-trace">{prosePreview}</pre>
        </details>
      ) : null}
    </div>
  )
}

export default function TradingSessionActivityFeed({
  events,
  turns,
  agentRunning,
  sessionStopped = false,
  onOpenStatusDrawer,
  session = null,
  onSessionUpdate,
}: Props) {
  const turnByRunId = useMemo(() => {
    const map = new Map<string, AgentTurn>()
    for (const turn of turns) map.set(turn.runId, turn)
    return map
  }, [turns])

  const statusCount = useMemo(() => statusEvents(events).length, [events])

  const orphanSurfaces = useMemo(() => {
    const runIds = new Set(turns.map(t => t.runId))
    const all = sessionA2uiSurfaces(events).filter(
      surface => !surface.components.some(c => c.component === 'TopStockPicks'),
    )
    return all.filter(surface => {
      const runId = surface.messageId.match(/session-text-(\d+)/)?.[1]
      if (!runId) return true
      return !runIds.has(runId)
    })
  }, [events, turns])

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
        {!hasAgentActivity && !agentRunning && !orphanSurfaces.length ? (
          <div className="am-empty-note">Waiting for agent activity…</div>
        ) : null}
        {orphanSurfaces.map(surface => (
          <div key={surface.messageId} className="am-ts-surface">
            <A2uiRenderer surface={surface} autonomousSession />
          </div>
        ))}
        {events.map(event => {
          if (!AGENT_INLINE_TYPES.has(event.event_type)) return null
          if (event.event_type === 'agent_run_started') {
            const runId = String(event.payload?.run_id || event.payload?.runId || '')
            if (renderedRuns.has(runId)) return null
            renderedRuns.add(runId)
            const turn = turnByRunId.get(runId)
            if (!turn) return null
            const running = agentRunning && !turn.finished
            return (
              <AgentTurnBlock
                key={`turn-${runId}`}
                turn={turn}
                running={running}
                sessionStopped={sessionStopped}
                events={events}
              />
            )
          }
          return null
        })}
        {agentRunning && turns.every(t => t.finished) ? (
          <div className="am-ts-turn">
            <span className="am-ts-thinking">Thinking…</span>
          </div>
        ) : null}
        {session && onSessionUpdate ? (
          <TradingSessionInstructionBar
            session={session}
            onSessionUpdate={onSessionUpdate}
            compact
          />
        ) : null}
      </div>
    </div>
  )
}
