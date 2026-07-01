import { useCallback, useEffect, useState } from 'react'

import {
  createAgentThread,
  getAgentThread,
  listAgentThreads,
  type AgentThread,
} from '../../../lib/agentThreads'
import { useUrlState } from '../useUrlState'
import AgentModeActiveWorkspace from './AgentModeActiveWorkspace'
import AgentModeSessionList from './AgentModeSessionList'
import AgentModeThreadsDrawer from './AgentModeThreadsDrawer'
import './AgentMode.css'

export default function AgentMode() {
  const { state, navigate } = useUrlState()
  const activeThreadId = state.agent_thread || ''
  const [threads, setThreads] = useState<AgentThread[]>([])
  const [activeThread, setActiveThread] = useState<AgentThread | null>(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)

  const refreshThreads = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const rows = await listAgentThreads()
      setThreads(rows)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load threads'
      setError(message === 'Not Found'
        ? 'Agent threads API is unavailable — restart the control plane (make dev).'
        : message)
      setThreads([])
      if (activeThreadId) {
        navigate({ tab: 'agent', agent_thread: '' }, { replace: true })
      }
    } finally {
      setLoading(false)
    }
  }, [activeThreadId, navigate])

  const refreshActiveThread = useCallback(async () => {
    if (!activeThreadId) return
    try {
      const thread = await getAgentThread(activeThreadId)
      setActiveThread(thread)
      setThreads(prev => {
        const next = prev.filter(item => item.thread_id !== thread.thread_id)
        return [thread, ...next]
      })
    } catch {
      // keep stale thread until next full refresh
    }
  }, [activeThreadId])

  useEffect(() => {
    void refreshThreads()
  }, [refreshThreads])

  useEffect(() => {
    if (!activeThreadId) {
      setActiveThread(null)
      return
    }
    if (loading) return
    const match = threads.find(thread => thread.thread_id === activeThreadId)
    if (match) {
      setActiveThread(match)
      return
    }
    void refreshActiveThread()
  }, [activeThreadId, loading, refreshActiveThread, threads])

  const selectThread = useCallback((threadId: string) => {
    navigate({ tab: 'agent', agent_thread: threadId })
  }, [navigate])

  const createThread = useCallback(async () => {
    setCreating(true)
    setError('')
    try {
      const thread = await createAgentThread(`Thread ${threads.length + 1}`)
      await refreshThreads()
      navigate({ tab: 'agent', agent_thread: thread.thread_id })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open thread')
    } finally {
      setCreating(false)
    }
  }, [navigate, refreshThreads, threads.length])

  const handleRunFinished = useCallback(() => {
    void refreshActiveThread()
  }, [refreshActiveThread])

  const handleThreadPatch = useCallback((patch: { title?: string; metadata?: Record<string, unknown> }) => {
    setActiveThread(prev => {
      if (!prev) return prev
      return {
        ...prev,
        title: patch.title ?? prev.title,
        metadata: patch.metadata ? { ...prev.metadata, ...patch.metadata } : prev.metadata,
      }
    })
    setThreads(prev => prev.map(row => {
      if (row.thread_id !== activeThreadId) return row
      return {
        ...row,
        title: patch.title ?? row.title,
        metadata: patch.metadata ? { ...row.metadata, ...patch.metadata } : row.metadata,
      }
    }))
    void refreshActiveThread()
  }, [activeThreadId, refreshActiveThread])

  if (!activeThreadId) {
    return (
      <div className="am-root">
        <div className="am-grid am-grid--threads-only">
          <AgentModeSessionList
            threads={threads}
            activeThreadId={activeThreadId}
            loading={loading}
            creating={creating}
            listError={error}
            onSelect={selectThread}
            onCreate={() => { void createThread() }}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="am-root">
      <header className="am-workspace-header">
        <div className="am-workspace-header__actions">
          <button type="button" className="am-thread-menu-btn" onClick={() => setDrawerOpen(true)}>
            Threads
          </button>
          <button
            type="button"
            className="am-thread-add"
            onClick={() => { void createThread() }}
            disabled={creating}
            aria-label={creating ? 'Opening thread' : 'New thread'}
            title="New thread"
          >
            {creating ? '…' : '+'}
          </button>
        </div>
        <span className="am-workspace-title">{activeThread?.title || 'Thread'}</span>
      </header>
      {activeThread ? (
        <AgentModeActiveWorkspace
          thread={activeThread}
          onRunFinished={handleRunFinished}
          onThreadPatch={handleThreadPatch}
        />
      ) : (
        <div className="am-chat-empty">Loading thread…</div>
      )}
      <AgentModeThreadsDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        threads={threads}
        activeThreadId={activeThreadId}
        loading={loading}
        creating={creating}
        listError={error}
        onSelect={selectThread}
        onCreate={() => { void createThread() }}
      />
    </div>
  )
}
