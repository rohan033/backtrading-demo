import { formatDbTimestamp } from '../../../lib/datetime'
import { displayStoppedReason, sessionLabel, type TradingSession } from '@/lib/tradingSessions'

type Props = {
  sessions: TradingSession[]
  activeSessionId: string
  loading: boolean
  creating: boolean
  listError?: string
  onSelect: (sessionId: string) => void
  onCreate: () => void
  onDelete?: (sessionId: string) => void
  deletingId?: string
}

export default function AgentModeSessionList({
  sessions,
  activeSessionId,
  loading,
  creating,
  listError,
  onSelect,
  onCreate,
  onDelete,
  deletingId,
}: Props) {
  return (
    <aside className="am-column">
      <div className="am-column-header am-column-header--with-action">
        <span>AI trades</span>
        <button
          type="button"
          className="am-thread-add"
          onClick={onCreate}
          disabled={creating}
          aria-label={creating ? 'Creating session' : 'New AI trade session'}
          title="New AI trade session"
        >
          {creating ? '…' : '+'}
        </button>
      </div>
      <div className="am-column-body am-thread-panel">
        {listError ? <div className="am-thread-list-error">{listError}</div> : null}
        {loading ? (
          <div className="am-empty-note">Loading AI trades…</div>
        ) : sessions.length ? (
          <table className="am-thread-table">
            <tbody>
              {sessions.map(session => {
                const active = session.id === activeSessionId
                const stoppedNote = displayStoppedReason(session.stopped_reason)
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
                        {onDelete ? (
                          <button
                            type="button"
                            className="am-thread-delete"
                            aria-label={`Delete session ${sessionLabel(session)}`}
                            title="Delete session"
                            disabled={deletingId === session.id}
                            onClick={event => {
                              event.stopPropagation()
                              onDelete(session.id)
                            }}
                          >
                            {deletingId === session.id ? '…' : '×'}
                          </button>
                        ) : null}
                      </div>
                      <div className="am-thread-row__meta">
                        ${session.max_capital} → ${session.profit_target}
                        {' · '}
                        {formatDbTimestamp(session.updated_at)}
                      </div>
                      {stoppedNote ? (
                        <div className="am-thread-row__meta am-thread-row__meta--reason">
                          {stoppedNote}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <div className="am-empty-note">No AI trades yet. Tap + to start a session.</div>
        )}
      </div>
    </aside>
  )
}
