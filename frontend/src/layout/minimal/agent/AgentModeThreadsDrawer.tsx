import type { TradingSession } from '@/lib/tradingSessions'
import AgentModeSessionList from './AgentModeSessionList'

type Props = {
  open: boolean
  onClose: () => void
  sessions: TradingSession[]
  activeSessionId: string
  loading: boolean
  creating: boolean
  listError: string
  onSelect: (sessionId: string) => void
  onCreate: () => void
  onDelete?: (sessionId: string) => void
  deletingId?: string
}

export default function AgentModeThreadsDrawer({
  open,
  onClose,
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
  if (!open) return null

  return (
    <div className="am-drawer-backdrop" onClick={onClose} role="presentation">
      <aside
        className="am-drawer"
        onClick={event => event.stopPropagation()}
        aria-label="AI trades"
      >
        <AgentModeSessionList
          sessions={sessions}
          activeSessionId={activeSessionId}
          loading={loading}
          creating={creating}
          listError={listError}
          onSelect={sessionId => {
            onSelect(sessionId)
            onClose()
          }}
          onCreate={onCreate}
          onDelete={onDelete}
          deletingId={deletingId}
        />
      </aside>
    </div>
  )
}
