import type { AgenticMonitorState } from '@/lib/agenticSessions'
import { Panel } from './shared'

const MONITOR_ORDER = [
  'halt_monitor',
  'news_monitor',
  'rotation_monitor',
  'risk_monitor',
  'portfolio_monitor',
] as const

const FALLBACK_LABELS: Record<string, string> = {
  halt_monitor: 'Halt monitor',
  news_monitor: 'News monitor',
  rotation_monitor: 'Rotation monitor',
  risk_monitor: 'Risk monitor',
  portfolio_monitor: 'Portfolio monitor',
}

function monitorTone(status: string): 'idle' | 'active' | 'degraded' | 'unavailable' {
  if (status === 'degraded' || status === 'active' || status === 'unavailable') return status
  return 'idle'
}

export default function MarketMonitorPanel({
  monitors,
}: {
  monitors: Record<string, AgenticMonitorState>
}) {
  const cards = MONITOR_ORDER.map(name => {
    const state = monitors[name]
    return (
      state || {
        name,
        label: FALLBACK_LABELS[name] ?? name,
        status: 'idle',
        oneline: 'Waiting for first tick…',
        data: {},
        should_spawn_sub_agent: false,
        updated_at: null,
      }
    )
  })

  return (
    <Panel title="Market Monitor" bodyClassName="ags-monitor__body">
      <div className="ags-monitor-grid">
        {cards.map(card => {
          const tone = monitorTone(card.status)
          return (
            <article key={card.name} className={`ags-monitor-card ags-monitor-card--${tone}`}>
              <div className="ags-monitor-card__head">
                <span className="ags-monitor-card__label">{card.label}</span>
                <span className={`ags-monitor-card__state ags-monitor-card__state--${tone}`}>
                  {tone}
                </span>
              </div>
              <p className="ags-monitor-card__oneline">{card.oneline || '—'}</p>
              {card.should_spawn_sub_agent ? (
                <span className="ags-monitor-card__flag">wants subagent</span>
              ) : null}
            </article>
          )
        })}
      </div>
    </Panel>
  )
}
