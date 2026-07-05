import { formatDbTimestamp } from '../../../lib/datetime'
import { sessionLabel, type TradingSession } from '@/lib/tradingSessions'

type Props = {
  sessions: TradingSession[]
  activeSessionId: string
  loading: boolean
  creating: boolean
  listError?: string
  onSelect: (sessionId: string) => void
  onCreate: () => void
}

export default function AgentModeSessionList({
  sessions,
  activeSessionId,
  loading,
  creating,
  listError,
  onSelect,
  onCreate,
}: Props) {
  return (
    <aside className="am-column">
      <div className="am-column-header am-column-header--with-action">
        <span>Sessions</span>
        <button
          type="button"
          className="am-thread-add"
          onClick={onCreate}
          disabled={creating}
          aria-label={creating ? 'Creating session' : 'New session'}
          title="New session"
        >
          {creating ? '…' : '+'}
        </button>
      </div>
      <div className="am-column-body am-thread-panel">
        {listError ? <div className="am-thread-list-error">{listError}</div> : null}
        {loading ? (
          <div className="am-empty-note">Loading sessions…</div>
        ) : sessions.length ? (
          <table className="am-thread-table">
            <tbody>
              {sessions.map(session => {
                const active = session.id === activeSessionId
                return (
                  <tr
                    key={session.id}
                    className={`am-thread-row${active ? ' am-thread-row--active' : ''}`}
                    onClick={() => onSelect(session.id)}
                  >
                    <td className="am-thread-row__cell">
                      <div className="am-thread-row__title">
                        <span className={`am-ts-badge am-ts-badge--${session.state}`}>{session.state}</span>
                        {sessionLabel(session)}
                      </div>
                      <div className="am-thread-row__meta">
                        ${session.max_capital} → ${session.profit_target}
                        {' · '}
                        {formatDbTimestamp(session.updated_at)}
                      </div>
                      {session.stopped_reason ? (
                        <div className="am-thread-row__meta am-thread-row__meta--reason">
                          {session.stopped_reason}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <div className="am-empty-note">No sessions yet. Tap + to start one.</div>
        )}
      </div>
    </aside>
  )
}
