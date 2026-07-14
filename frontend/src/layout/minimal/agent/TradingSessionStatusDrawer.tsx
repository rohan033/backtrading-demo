import { A2uiRenderer } from '@/components/agent/A2uiRenderer'
import { displayStateReason, displayStoppedReason, type TradingSessionEvent } from '@/lib/tradingSessions'
import { surfaceFromSessionEvent } from '@/lib/tradingSessionSurfaces'

const AGENT_INLINE_TYPES = new Set([
  'agent_run_started',
  'agent_run_finished',
  'agent_thinking',
  'agent_tool_call',
  'agent_text',
])

export function isStatusEvent(event: TradingSessionEvent): boolean {
  if (AGENT_INLINE_TYPES.has(event.event_type)) return false
  if (event.event_type === 'agent_picks') return false
  if (
    event.event_type === 'agent_a2ui_surface'
    && Array.isArray(event.payload?.components)
    && event.payload.components.some((c: { component?: string }) => c.component === 'TopStockPicks')
  ) {
    return false
  }
  return true
}

export function statusEvents(events: TradingSessionEvent[]): TradingSessionEvent[] {
  return events.filter(isStatusEvent)
}

function LogRow({
  label,
  main,
  meta,
}: {
  label: string
  main: string
  meta?: string | null
}) {
  return (
    <div className="am-ts-log-row">
      <span className="am-ts-log-row__label">{label}</span>
      <div className="am-ts-log-row__content">
        <span className="am-ts-log-row__main">{main}</span>
        {meta ? <span className="am-ts-log-row__meta">{meta}</span> : null}
      </div>
    </div>
  )
}

function StatusEventRow({ event }: { event: TradingSessionEvent }) {
  const p = event.payload || {}
  const a2uiSurface = surfaceFromSessionEvent(event)

  if (a2uiSurface && (event.event_type === 'agent_a2ui_surface' || event.event_type === 'agent_picks')) {
    return (
      <div className="am-ts-log-row am-ts-log-row--block">
        <A2uiRenderer surface={a2uiSurface} autonomousSession />
      </div>
    )
  }

  if (event.event_type === 'state_entered') {
    const from = p.from_state ? `${String(p.from_state)} → ` : ''
    const reason = displayStateReason(String(p.reason || ''))
    return (
      <LogRow
        label="State"
        main={`${from}${String(p.state)}`}
        meta={reason}
      />
    )
  }

  if (event.event_type === 'symbol_resolved') {
    return (
      <LogRow
        label="Symbol"
        main={`${String(p.symbol)} · ${String(p.token)}`}
      />
    )
  }

  if (event.event_type === 'top_pick_selected') {
    return (
      <LogRow
        label="Top pick"
        main={String(p.symbol)}
        meta={p.recommendation ? String(p.recommendation) : null}
      />
    )
  }

  if (event.event_type === 'session_stopped' || event.event_type === 'agent_explore_failed') {
    const reason = displayStoppedReason(String(p.stopped_reason || p.reason || ''))
      || (event.event_type === 'agent_explore_failed' ? String(p.reason || '') : null)
    if (event.event_type === 'session_stopped' && !reason) return null
    return (
      <LogRow
        label={event.event_type === 'session_stopped' ? 'Stopped' : 'Failed'}
        main={reason || '—'}
      />
    )
  }

  if (event.event_type === 'session_created' || event.event_type === 'agent_explore_started') {
    return (
      <LogRow
        label={event.event_type === 'session_created' ? 'Created' : 'Explore'}
        main="Session started"
      />
    )
  }

  if (event.event_type === 'user_instruction') {
    const resume = p.resume_state ? String(p.resume_state) : null
    return (
      <LogRow
        label="Instruction"
        main={String(p.prompt || '—')}
        meta={resume ? `Resume ${resume}` : null}
      />
    )
  }

  return (
    <LogRow
      label={event.event_type}
      main={JSON.stringify(p).slice(0, 80)}
    />
  )
}

type DrawerProps = {
  open: boolean
  onClose: () => void
  events: TradingSessionEvent[]
}

export default function TradingSessionStatusDrawer({ open, onClose, events }: DrawerProps) {
  if (!open) return null

  const rows = statusEvents(events)

  return (
    <div className="am-ts-status-backdrop" onClick={onClose} role="presentation">
      <aside
        className="am-ts-status-drawer"
        onClick={e => e.stopPropagation()}
        aria-label="Session status log"
      >
        <header className="am-ts-status-drawer__head">
          <span className="am-ts-status-drawer__title">Session log</span>
          <button type="button" className="am-ts-status-drawer__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="am-ts-status-drawer__body">
          {!rows.length ? (
            <div className="am-empty-note">No status events yet.</div>
          ) : (
            rows.map(event => <StatusEventRow key={event.id} event={event} />)
          )}
        </div>
      </aside>
    </div>
  )
}
