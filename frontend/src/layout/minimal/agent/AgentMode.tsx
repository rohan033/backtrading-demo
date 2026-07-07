import { useCallback, useEffect, useState } from 'react'

import {
  deleteTradingSession,
  getTradingSession,
  listTradingSessions,
  sessionLabel,
  type TradingSession,
} from '@/lib/tradingSessions'
import { useUrlState } from '../useUrlState'
import AgentModeCreateSession from './AgentModeCreateSession'
import AgentModeSessionList from './AgentModeSessionList'
import AgentModeSessionWorkspace from './AgentModeSessionWorkspace'
import AgentModeThreadsDrawer from './AgentModeThreadsDrawer'
import './AgentMode.css'

export default function AgentMode() {
  const { state, navigate } = useUrlState()
  const activeSessionId = state.trading_session || ''
  const [sessions, setSessions] = useState<TradingSession[]>([])
  const [activeSession, setActiveSession] = useState<TradingSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [error, setError] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [deletingId, setDeletingId] = useState('')

  const refreshSessions = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const rows = await listTradingSessions()
      setSessions(rows)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load sessions'
      setError(message === 'Not Found'
        ? 'Trading sessions API is unavailable — restart the control plane (make dev).'
        : message)
      setSessions([])
      if (activeSessionId) {
        navigate({ tab: 'agent', trading_session: '' }, { replace: true })
      }
    } finally {
      setLoading(false)
    }
  }, [activeSessionId, navigate])

  const refreshActiveSession = useCallback(async () => {
    if (!activeSessionId) return
    try {
      const session = await getTradingSession(activeSessionId)
      setActiveSession(session)
      setSessions(prev => {
        const next = prev.filter(item => item.id !== session.id)
        return [session, ...next]
      })
    } catch {
      // keep stale
    }
  }, [activeSessionId])

  useEffect(() => {
    void refreshSessions()
  }, [refreshSessions])

  useEffect(() => {
    if (!activeSessionId) {
      setActiveSession(null)
      return
    }
    if (loading) return
    const match = sessions.find(s => s.id === activeSessionId)
    if (match) {
      setActiveSession(match)
      return
    }
    void refreshActiveSession()
  }, [activeSessionId, loading, refreshActiveSession, sessions])

  const selectSession = useCallback((sessionId: string) => {
    navigate({ tab: 'agent', trading_session: sessionId })
  }, [navigate])

  const handleCreated = useCallback((session: TradingSession) => {
    setActiveSession(session)
    setSessions(prev => [session, ...prev.filter(row => row.id !== session.id)])
    navigate({ tab: 'agent', trading_session: session.id })
    void refreshSessions()
  }, [navigate, refreshSessions])

  const handleSessionUpdate = useCallback((session: TradingSession) => {
    setActiveSession(session)
    setSessions(prev => {
      const next = prev.filter(row => row.id !== session.id)
      return [session, ...next]
    })
  }, [])

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    const target = sessions.find(row => row.id === sessionId)
    const label = target ? sessionLabel(target) : 'this session'
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return

    setDeletingId(sessionId)
    setError('')
    try {
      await deleteTradingSession(sessionId)
      setSessions(prev => prev.filter(row => row.id !== sessionId))
      if (activeSessionId === sessionId) {
        setActiveSession(null)
        navigate({ tab: 'agent', trading_session: '' }, { replace: true })
      } else if (activeSession?.id === sessionId) {
        setActiveSession(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete session')
    } finally {
      setDeletingId('')
    }
  }, [activeSession?.id, activeSessionId, navigate, sessions])

  if (!activeSessionId) {
    return (
      <div className="am-root">
        <AgentModeCreateSession
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={handleCreated}
        />
        <div className="am-grid am-grid--threads-only">
          <AgentModeSessionList
            sessions={sessions}
            activeSessionId={activeSessionId}
            loading={loading}
            creating={createOpen}
            listError={error}
            onSelect={selectSession}
            onCreate={() => setCreateOpen(true)}
            onDelete={handleDeleteSession}
            deletingId={deletingId}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="am-root">
      <AgentModeCreateSession
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />
      {activeSessionId && activeSession?.id === activeSessionId ? (
        <AgentModeSessionWorkspace
          key={activeSessionId}
          sessionId={activeSessionId}
          onSessionUpdate={handleSessionUpdate}
          onOpenSessions={() => setDrawerOpen(true)}
          onCreateSession={() => setCreateOpen(true)}
          onDelete={() => { void handleDeleteSession(activeSessionId) }}
          deleting={deletingId === activeSessionId}
        />
      ) : activeSessionId ? (
        <div className="am-chat-empty">Loading session…</div>
      ) : null}
      <AgentModeThreadsDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        sessions={sessions}
        activeSessionId={activeSessionId}
        loading={loading}
        creating={createOpen}
        listError={error}
        onSelect={selectSession}
        onCreate={() => setCreateOpen(true)}
        onDelete={handleDeleteSession}
        deletingId={deletingId}
      />
    </div>
  )
}
