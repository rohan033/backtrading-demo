import { useMemo } from 'react'

import type { AgentThread } from '../../../lib/agentThreads'

type Props = {
  thread: AgentThread | null
}

export default function AgentModeTradePanel({ thread }: Props) {
  const actions = useMemo(() => thread?.actions || [], [thread?.actions])
  const strategyActions = useMemo(
    () => actions.filter(action => action.type.includes('strategy') || Boolean(action.payload?.symbol)),
    [actions],
  )
  const latestStrategy = strategyActions[0]

  return (
    <aside className="am-column">
      <div className="am-column-header">Live context</div>
      <div className="am-column-body">
        <section className="am-trade-section">
          <div className="am-trade-section__title">Trade focus</div>
          <p className="am-trade-section__hint">
            Symbol, risk, and targets the agent is working on in this thread.
          </p>
          {latestStrategy ? (
            <div className="am-trade-card">
              <div className="am-trade-card__title">{latestStrategy.title}</div>
              <div className="am-trade-card__meta">
                {String(latestStrategy.payload?.symbol || 'Symbol pending')}
                {latestStrategy.payload?.long_percent != null
                  ? ` · target ${latestStrategy.payload.long_percent}%`
                  : ''}
                {latestStrategy.payload?.short_percent != null
                  ? ` · stop ${latestStrategy.payload.short_percent}%`
                  : ''}
              </div>
              {thread?.summary ? (
                <div className="am-trade-card__meta" style={{ marginTop: 6 }}>
                  {thread.summary}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="am-trade-card">
              <div className="am-trade-card__meta">
                {thread
                  ? 'No trade focus yet. Switch to Trade mode and ask the agent to work a setup.'
                  : 'Open a thread to see live trade context.'}
              </div>
            </div>
          )}
        </section>

        <section className="am-trade-section">
          <div className="am-trade-section__title">Orders / positions</div>
          <p className="am-trade-section__hint">Executions linked to this thread will show here.</p>
          <div className="am-trade-card">
            <div className="am-trade-card__meta">No linked orders or positions yet.</div>
          </div>
        </section>

        <section className="am-trade-section">
          <div className="am-trade-section__title">Agent activity</div>
          {actions.length ? (
            actions.slice(0, 6).map(action => (
              <div key={action.id} className="am-trade-card">
                <div className="am-trade-card__title">{action.title}</div>
                <div className="am-trade-card__meta">
                  {action.type.replace(/_/g, ' ')}
                  {action.status ? ` · ${action.status}` : ''}
                </div>
              </div>
            ))
          ) : (
            <div className="am-trade-card">
              <div className="am-trade-card__meta">
                Steps, tool calls, and deploy actions will land here.
              </div>
            </div>
          )}
        </section>
      </div>
    </aside>
  )
}
