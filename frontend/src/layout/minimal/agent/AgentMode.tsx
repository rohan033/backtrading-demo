import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  deleteTradingSession,
  getTradingSession,
  listTradingSessions,
  sessionLabel,
  type TradingSession,
} from '@/lib/tradingSessions'
import {
  deleteOnePercentSession,
  getOnePercentSession,
  listOnePercentSessions,
  onePercentSessionLabel,
  type OnePercentSession,
  type OnePercentSessionDetail,
} from '@/lib/onePercentSessions'
import { useUrlState } from '../useUrlState'
import AgentModeCreateSession from './AgentModeCreateSession'
import AgentModeSessionList from './AgentModeSessionList'
import AgentModeSessionWorkspace from './AgentModeSessionWorkspace'
import AgentModeThreadsDrawer from './AgentModeThreadsDrawer'
import AgenticSessions from './AgenticSessions'
import OnePercentTradesPanel from './OnePercentTradesPanel'
import './AgentMode.css'
import './OnePercentSessions.css'

type AgentSubpanel = 'ai' | '1pc' | 'agentic'

export default function AgentMode() {
  const { state, navigate } = useUrlState()
  const activeSessionId = state.trading_session || ''
  const activeOnePercentSessionId = state.one_percent_session || ''
  const activeAgenticSessionId = state.agentic_session || ''

  const subpanel: AgentSubpanel = useMemo(() => {
    if (
      state.agent_panel === '1pc'
      || state.agent_panel === 'ai'
      || state.agent_panel === 'agentic'
    ) {
      return state.agent_panel
    }
    if (activeAgenticSessionId) return 'agentic'
    if (activeOnePercentSessionId) return '1pc'
    return 'ai'
  }, [activeAgenticSessionId, activeOnePercentSessionId, state.agent_panel])

  const [sessions, setSessions] = useState<TradingSession[]>([])
  const [onePercentSessions, setOnePercentSessions] = useState<OnePercentSession[]>([])
  const [activeSession, setActiveSession] = useState<TradingSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [error, setError] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [deletingId, setDeletingId] = useState('')

  const setSubpanel = useCallback((next: AgentSubpanel) => {
    if (next === 'ai') {
      navigate({
        tab: 'agent',
        agent_panel: 'ai',
        one_percent_session: '',
        agentic_session: '',
        trading_session: activeSessionId || '',
      })
      return
    }
    // Land on the session list by default — don't reopen the last session.
    navigate({
      tab: 'agent',
      agent_panel: next,
      trading_session: '',
      one_percent_session: '',
      agentic_session: '',
    })
  }, [activeSessionId, navigate])

  const refreshSessions = useCallback(async () => {
    setLoading(true)
    setError('')
    const results = await Promise.allSettled([
      listTradingSessions(),
      listOnePercentSessions(),
    ])
    const [tradingResult, onePercentResult] = results
    if (tradingResult.status === 'fulfilled') {
      setSessions(tradingResult.value)
    }
    if (onePercentResult.status === 'fulfilled') {
      setOnePercentSessions(onePercentResult.value)
    }

    const failures = [tradingResult, onePercentResult].filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failures.length === 2) {
      const message = failures[0].reason instanceof Error
        ? failures[0].reason.message
        : 'Failed to load sessions'
      setError(message === 'Not Found'
        ? 'Trading sessions API is unavailable — restart the control plane (make dev).'
        : message)
      setSessions([])
      setOnePercentSessions([])
      if (activeSessionId || activeOnePercentSessionId) {
        navigate({
          tab: 'agent',
          agent_panel: subpanel,
          trading_session: '',
          one_percent_session: '',
        }, { replace: true })
      }
    } else if (failures.length === 1) {
      const message = failures[0].reason instanceof Error
        ? failures[0].reason.message
        : 'Failed to load some sessions'
      setError(message)
    }
    setLoading(false)
  }, [activeOnePercentSessionId, activeSessionId, navigate, subpanel])

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

  const refreshActiveOnePercent = useCallback(async () => {
    if (!activeOnePercentSessionId) return
    try {
      const session = await getOnePercentSession(activeOnePercentSessionId)
      setOnePercentSessions(prev => {
        const next = prev.filter(item => item.id !== session.id)
        return [session, ...next]
      })
    } catch {
      // keep stale
    }
  }, [activeOnePercentSessionId])

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

  useEffect(() => {
    if (!activeOnePercentSessionId || loading) return
    const match = onePercentSessions.find(s => s.id === activeOnePercentSessionId)
    if (match) return
    void refreshActiveOnePercent()
  }, [activeOnePercentSessionId, loading, onePercentSessions, refreshActiveOnePercent])

  const selectSession = useCallback((sessionId: string) => {
    navigate({
      tab: 'agent',
      agent_panel: 'ai',
      trading_session: sessionId,
      one_percent_session: '',
      agentic_session: '',
    })
  }, [navigate])

  const selectOnePercentSession = useCallback((sessionId: string) => {
    navigate({
      tab: 'agent',
      agent_panel: '1pc',
      one_percent_session: sessionId,
      trading_session: '',
      agentic_session: '',
    })
  }, [navigate])

  const clearOnePercentActive = useCallback(() => {
    navigate({
      tab: 'agent',
      agent_panel: '1pc',
      one_percent_session: '',
      trading_session: '',
    }, { replace: true })
  }, [navigate])

  const handleCreated = useCallback((session: TradingSession) => {
    setActiveSession(session)
    setSessions(prev => [session, ...prev.filter(row => row.id !== session.id)])
    navigate({
      tab: 'agent',
      agent_panel: 'ai',
      trading_session: session.id,
      one_percent_session: '',
      agentic_session: '',
    })
    void refreshSessions()
  }, [navigate, refreshSessions])

  const handleOnePercentCreated = useCallback((session: OnePercentSessionDetail) => {
    setOnePercentSessions(prev => [session, ...prev.filter(row => row.id !== session.id)])
    navigate({
      tab: 'agent',
      agent_panel: '1pc',
      one_percent_session: session.id,
      trading_session: '',
      agentic_session: '',
    })
    void refreshSessions()
  }, [navigate, refreshSessions])

  const handleSessionUpdate = useCallback((session: TradingSession) => {
    setActiveSession(session)
    setSessions(prev => {
      const next = prev.filter(row => row.id !== session.id)
      return [session, ...next]
    })
  }, [])

  const handleOnePercentUpdate = useCallback((session: OnePercentSession) => {
    setOnePercentSessions(prev => {
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
        navigate({
          tab: 'agent',
          agent_panel: 'ai',
          trading_session: '',
          one_percent_session: '',
        }, { replace: true })
      } else if (activeSession?.id === sessionId) {
        setActiveSession(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete session')
    } finally {
      setDeletingId('')
    }
  }, [activeSession?.id, activeSessionId, navigate, sessions])

  const handleDeleteOnePercent = useCallback(async (sessionId: string) => {
    const target = onePercentSessions.find(row => row.id === sessionId)
    const label = target ? onePercentSessionLabel(target) : 'this 1% session'
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return

    setDeletingId(sessionId)
    setError('')
    try {
      await deleteOnePercentSession(sessionId)
      setOnePercentSessions(prev => prev.filter(row => row.id !== sessionId))
      if (activeOnePercentSessionId === sessionId) {
        navigate({
          tab: 'agent',
          agent_panel: '1pc',
          trading_session: '',
          one_percent_session: '',
        }, { replace: true })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete 1% session')
    } finally {
      setDeletingId('')
    }
  }, [activeOnePercentSessionId, navigate, onePercentSessions])

  return (
    <div className="am-root">
      <div className="am-subpanel-tabs" role="tablist" aria-label="Agent subpanels">
        <button
          type="button"
          role="tab"
          aria-selected={subpanel === 'ai'}
          className={`am-subpanel-tab${subpanel === 'ai' ? ' am-subpanel-tab--active' : ''}`}
          onClick={() => setSubpanel('ai')}
        >
          AI trades
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subpanel === '1pc'}
          className={`am-subpanel-tab${subpanel === '1pc' ? ' am-subpanel-tab--active' : ''}`}
          onClick={() => setSubpanel('1pc')}
        >
          1pc trades
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subpanel === 'agentic'}
          className={`am-subpanel-tab${subpanel === 'agentic' ? ' am-subpanel-tab--active' : ''}`}
          onClick={() => setSubpanel('agentic')}
        >
          Agentic
        </button>
      </div>

      <AgentModeCreateSession
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />

      {subpanel === 'agentic' ? (
        <AgenticSessions />
      ) : subpanel === '1pc' ? (
        <OnePercentTradesPanel
          sessions={onePercentSessions}
          activeSessionId={activeOnePercentSessionId}
          loading={loading}
          listError={error}
          onRetryLoad={() => void refreshSessions()}
          onSelect={selectOnePercentSession}
          onCreated={handleOnePercentCreated}
          onSessionUpdate={handleOnePercentUpdate}
          onDelete={handleDeleteOnePercent}
          deletingId={deletingId}
          onClearActive={clearOnePercentActive}
        />
      ) : !activeSessionId ? (
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
      ) : activeSession?.id === activeSessionId ? (
        <>
          <AgentModeSessionWorkspace
            key={activeSessionId}
            sessionId={activeSessionId}
            onSessionUpdate={handleSessionUpdate}
            onOpenSessions={() => setDrawerOpen(true)}
            onCreateSession={() => setCreateOpen(true)}
            onDelete={() => { void handleDeleteSession(activeSessionId) }}
            deleting={deletingId === activeSessionId}
          />
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
        </>
      ) : (
        <div className="am-chat-empty">Loading AI trade…</div>
      )}
    </div>
  )
}
