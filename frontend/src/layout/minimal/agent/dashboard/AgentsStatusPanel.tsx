import { formatRelativeTimestamp } from '@/lib/datetime'
import type { AgenticSubagent } from '@/lib/agenticSessions'
import { ConfidenceBadge, Empty, Panel, StatusDot, agentGlyph, humanizeAgent } from './shared'

function subagentStatusTone(status: string): 'active' | 'degraded' | 'idle' {
  if (status === 'degraded' || status === 'failed') return 'degraded'
  if (status === 'active') return 'active'
  return 'idle'
}

export default function AgentsStatusPanel({ subagents }: { subagents: AgenticSubagent[] }) {
  return (
    <Panel
      title="Agents Status"
      count={subagents.length || undefined}
      className="ags-agents-panel"
      bodyClassName="ags-agents__body"
    >
      {subagents.length === 0 ? (
        <Empty>No subagents spawned yet.</Empty>
      ) : (
        <ul className="ags-agents" aria-label="Subagent status">
          {subagents.map(sub => {
            const tone = subagentStatusTone(sub.status)
            const finished = sub.status !== 'active'
            return (
              <li key={sub.id} className={`ags-agent-row ags-agent-row--${tone}`}>
                <span className="ags-agent-row__icon" aria-hidden>{agentGlyph(sub.name)}</span>
                <span className="ags-agent-row__name">
                  {humanizeAgent(sub.name)}
                  {sub.ticker ? <span className="ags-agent-row__ticker">{sub.ticker}</span> : null}
                </span>
                <span className="ags-agent-row__status">{sub.oneline || (finished ? 'Done' : 'Working…')}</span>
                {sub.confidence != null && finished ? (
                  <ConfidenceBadge value={sub.confidence} />
                ) : (
                  <StatusDot status={tone} />
                )}
                <time
                  className="ags-agent-row__time"
                  dateTime={sub.finished_at || sub.started_at}
                >
                  {formatRelativeTimestamp(sub.finished_at || sub.started_at)}
                </time>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}
