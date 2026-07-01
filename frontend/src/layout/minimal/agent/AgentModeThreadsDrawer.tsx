import type { AgentThread } from '@/lib/agentThreads'
import AgentModeSessionList from './AgentModeSessionList'

type Props = {
  open: boolean
  onClose: () => void
  threads: AgentThread[]
  activeThreadId: string
  loading: boolean
  creating: boolean
  listError: string
  onSelect: (threadId: string) => void
  onCreate: () => void
}

export default function AgentModeThreadsDrawer({
  open,
  onClose,
  threads,
  activeThreadId,
  loading,
  creating,
  listError,
  onSelect,
  onCreate,
}: Props) {
  if (!open) return null

  return (
    <div className="am-drawer-backdrop" onClick={onClose} role="presentation">
      <aside
        className="am-drawer"
        onClick={event => event.stopPropagation()}
        aria-label="Threads"
      >
        <AgentModeSessionList
          threads={threads}
          activeThreadId={activeThreadId}
          loading={loading}
          creating={creating}
          listError={listError}
          onSelect={threadId => {
            onSelect(threadId)
            onClose()
          }}
          onCreate={onCreate}
        />
      </aside>
    </div>
  )
}
