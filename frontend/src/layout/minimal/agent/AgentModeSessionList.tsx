import { formatDbTimestamp } from '../../../lib/datetime'
import type { AgentThread } from '../../../lib/agentThreads'

type Props = {
  threads: AgentThread[]
  activeThreadId: string
  loading: boolean
  creating: boolean
  listError?: string
  onSelect: (threadId: string) => void
  onCreate: () => void
}

export default function AgentModeSessionList({
  threads,
  activeThreadId,
  loading,
  creating,
  listError,
  onSelect,
  onCreate,
}: Props) {
  return (
    <aside className="am-column">
      <div className="am-column-header am-column-header--with-action">
        <span>Threads</span>
        <button
          type="button"
          className="am-thread-add"
          onClick={onCreate}
          disabled={creating}
          aria-label={creating ? 'Opening thread' : 'New thread'}
          title="New thread"
        >
          {creating ? '…' : '+'}
        </button>
      </div>
      <div className="am-column-body am-thread-panel">
        {listError ? <div className="am-thread-list-error">{listError}</div> : null}
        {loading ? (
          <div className="am-empty-note">Loading threads…</div>
        ) : threads.length ? (
          <table className="am-thread-table">
            <tbody>
              {threads.map(thread => {
                const active = thread.thread_id === activeThreadId
                return (
                  <tr
                    key={thread.thread_id}
                    className={`am-thread-row${active ? ' am-thread-row--active' : ''}`}
                    onClick={() => onSelect(thread.thread_id)}
                  >
                    <td className="am-thread-row__cell">
                      <div className="am-thread-row__title">{thread.title}</div>
                      <div className="am-thread-row__meta">
                        {formatDbTimestamp(thread.last_message_at || thread.updated_at)}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <div className="am-empty-note">No threads yet. Tap + to open one.</div>
        )}
      </div>
    </aside>
  )
}
