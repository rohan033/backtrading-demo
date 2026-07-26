import { useCallback, useEffect, useMemo, useState } from 'react'

import { useOverviewTradeSignals } from '@/hooks/useOverviewTradeSignals'
import {
  agenticApiUnavailable,
  agenticSessionLabel,
  closeAgenticPosition,
  getAgenticSession,
  getAgenticSessionSnapshot,
  haltAgenticSubagents,
  pauseAgenticSession,
  resumeAgenticSession,
  resumeAgenticSubagents,
  stopAgenticSession,
  updateAgenticSessionModel,
  type AgenticSession,
  type AgenticSessionPosition,
  type AgenticSessionSnapshot,
} from '@/lib/agenticSessions'
import { useAgenticLivePortfolio } from '@/hooks/useAgenticLivePortfolio'
import AgentsStatusPanel from './dashboard/AgentsStatusPanel'
import AgentModelPicker, {
  agentModelFromSessionConfig,
} from './dashboard/AgentModelPicker'
import LogPanel from './dashboard/LogPanel'
import MarketMonitorPanel from './dashboard/MarketMonitorPanel'
import MarketScannerPanel from './dashboard/MarketScannerPanel'
import OverviewPanel from './dashboard/OverviewPanel'
import ExitPlansPanel from './dashboard/ExitPlansPanel'
import PositionsPanel from './dashboard/PositionsPanel'
import { buildLog, splitLogEntries } from './dashboard/logModel'
import { Empty } from './dashboard/shared'
import './AgenticSessions.css'

const POLL_MS = 4000

function modelValueEquals(
  a: ReturnType<typeof agentModelFromSessionConfig>,
  b: ReturnType<typeof agentModelFromSessionConfig>,
): boolean {
  if (a.agentModelId !== b.agentModelId) return false
  if (a.agentModelParams.length !== b.agentModelParams.length) return false
  return a.agentModelParams.every((row, index) =>
    row.id === b.agentModelParams[index]?.id
    && row.value === b.agentModelParams[index]?.value,
  )
}

export default function AgenticSessionWorkspace({
  sessionId,
  onBack,
}: {
  sessionId: string
  onBack: () => void
}) {
  const [session, setSession] = useState<AgenticSession | null>(null)
  const [snapshot, setSnapshot] = useState<AgenticSessionSnapshot | null>(null)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [stopping, setStopping] = useState(false)
  const [pausing, setPausing] = useState(false)
  const [subagentsToggling, setSubagentsToggling] = useState(false)
  const [closingId, setClosingId] = useState('')
  const [modelSaving, setModelSaving] = useState(false)
  const [modelValue, setModelValue] = useState(() => agentModelFromSessionConfig(undefined))

  const accountEnv: 'demo' | 'live' = session?.account_env === 'live' ? 'live' : 'demo'

  const scanner = useOverviewTradeSignals({
    enabled: session?.status === 'running',
    accountEnv,
  })

  const load = useCallback(async () => {
    try {
      const [nextSession, nextSnapshot] = await Promise.all([
        getAgenticSession(sessionId),
        getAgenticSessionSnapshot(sessionId),
      ])
      setSession(nextSession)
      setSnapshot(nextSnapshot)
      setModelValue(agentModelFromSessionConfig(nextSession.config))
      setError('')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load session'
      setError(agenticApiUnavailable(message)
        ? 'Agentic trading API is unavailable. Start the backend and retry.'
        : message)
    }
  }, [sessionId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!session) return
    // Positions also use the shared eToro watchlist websocket (see useAgenticPositionLiveFeed).
    // Keep REST snapshot polling for portfolio stats, logs, and orchestrator state.
    const interval = session.status === 'running' ? POLL_MS : POLL_MS * 2
    const timer = window.setInterval(() => void load(), interval)
    return () => window.clearInterval(timer)
  }, [load, session?.id, session?.status])

  const stop = useCallback(async () => {
    if (
      !session
      || !window.confirm(
        `Stop ${agenticSessionLabel(session)}? All background agents will halt. Open positions stay at the broker until you close them.`,
      )
    ) {
      return
    }
    setStopping(true)
    setActionError('')
    try {
      setSession(await stopAgenticSession(session.id))
      await load()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to stop session')
    } finally {
      setStopping(false)
    }
  }, [load, session])

  const closePosition = useCallback(async (position: AgenticSessionPosition) => {
    if (!window.confirm(`Close ${position.ticker} at market? This request is sent at most once.`)) return
    setClosingId(position.id)
    setActionError('')
    try {
      await closeAgenticPosition(sessionId, position.id)
      await load()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to close position')
    } finally {
      setClosingId('')
    }
  }, [load, sessionId])

  const togglePause = useCallback(async () => {
    if (!session || session.status === 'stopped') return
    setPausing(true)
    setActionError('')
    try {
      setSession(session.status === 'paused'
        ? await resumeAgenticSession(session.id)
        : await pauseAgenticSession(session.id))
      await load()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update session')
    } finally {
      setPausing(false)
    }
  }, [load, session])

  const toggleSubagents = useCallback(async () => {
    if (!session || session.status === 'stopped') return
    const halted = Boolean(snapshot?.agent_state?.subagents_halted)
    setSubagentsToggling(true)
    setActionError('')
    try {
      const result = halted
        ? await resumeAgenticSubagents(session.id)
        : await haltAgenticSubagents(session.id)
      setSession(result.session)
      await load()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update subagents')
    } finally {
      setSubagentsToggling(false)
    }
  }, [load, session, snapshot?.agent_state?.subagents_halted])

  const saveModel = useCallback(async (next: typeof modelValue) => {
    setModelSaving(true)
    setActionError('')
    try {
      setSession(await updateAgenticSessionModel(sessionId, {
        agent_model: next.agentModelId || null,
        agent_model_params: next.agentModelParams.filter(row => row.id && row.value),
      }))
      await load()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update model')
    } finally {
      setModelSaving(false)
    }
  }, [load, sessionId])

  const logEntries = useMemo(
    () => (snapshot ? buildLog(snapshot.events, snapshot.thinking || []) : []),
    [snapshot],
  )

  const { orchestrator: orchestratorLogs, subagents: subagentLogs } = useMemo(
    () => splitLogEntries(logEntries),
    [logEntries],
  )

  const portfolio = snapshot?.portfolio ?? {
    start_balance: 0,
    equity: 0,
    total_pnl: 0,
    daily_pnl: 0,
    invested: 0,
    exposure_pct: 0,
    win_rate: null,
    open_positions: 0,
    trades_taken: 0,
    max_exposure_pct: 80,
  }
  const positions = useMemo(
    () => (snapshot?.positions ?? []).filter(row => !['closed', 'failed'].includes(row.state)),
    [snapshot?.positions],
  )
  const livePortfolio = useAgenticLivePortfolio(accountEnv, positions, portfolio)

  if (!session || !snapshot) {
    return (
      <div className="ags-root ags-wire">
        <header className="ags-wire-bar">
          <button type="button" className="ags-wire-bar__back" onClick={onBack}>← Back</button>
        </header>
        {error ? <div className="ags-error">{error}</div> : <Empty>Loading session…</Empty>}
      </div>
    )
  }

  const interactive = session.status !== 'stopped'
  const simulated = session.config?.dry_run === true
  const envLabel = accountEnv === 'live' ? 'LIVE' : 'DEMO'

  return (
    <div className="ags-root ags-wire">
      <header className="ags-wire-bar">
        <div className="ags-wire-bar__id">
          <span className="ags-wire-bar__label">Session</span>
          <span className="ags-wire-bar__value" title={session.id}>{agenticSessionLabel(session)}</span>
          <span className={`ags-status-pill ags-status-pill--${session.status}`}>{session.status}</span>
          {session.stop_reason ? (
            <span className="ags-stop-reason-pill" title={session.stop_reason}>
              {session.stop_reason}
            </span>
          ) : null}
          <span className="ags-wire-bar__env">
            {envLabel}{simulated ? ' · SIM' : ''}
          </span>
        </div>
        <div className="ags-wire-bar__actions">
          <div className="ags-wire-bar__model">
            <AgentModelPicker
              compact
              dense
              disabled={modelSaving}
              value={modelValue}
              onChange={next => {
                setModelValue(next)
                const persisted = agentModelFromSessionConfig(session.config)
                if (!modelValueEquals(next, persisted)) {
                  void saveModel(next)
                }
              }}
            />
          </div>
          {interactive ? (
            <button
              type="button"
              className="ags-wire-btn ags-wire-btn--ghost"
              disabled={pausing}
              onClick={() => void togglePause()}
            >
              {pausing ? '…' : session.status === 'paused' ? 'Resume' : 'Pause'}
            </button>
          ) : null}
          <button type="button" className="ags-wire-btn ags-wire-btn--back" onClick={onBack}>Back</button>
          {interactive ? (
            <button
              type="button"
              className="ags-wire-btn ags-wire-btn--stop"
              disabled={stopping}
              onClick={() => void stop()}
            >
              {stopping ? '…' : 'Stop'}
            </button>
          ) : null}
        </div>
      </header>
      {error ? <div className="ags-error">{error}</div> : null}
      {actionError ? <div className="ags-error">{actionError}</div> : null}

      <main className="ags-wire-grid">
        <div className="ags-wire-col ags-wire-col--left">
          <OverviewPanel portfolio={portfolio} live={livePortfolio} />
          <PositionsPanel
            positions={positions}
            closingId={closingId}
            onClose={closePosition}
            interactive={interactive}
            liveByTicker={livePortfolio.byTicker}
          />
          <ExitPlansPanel
            positions={positions}
            liveByTicker={livePortfolio.byTicker}
            portfolioMonitor={snapshot.monitors?.portfolio_monitor}
          />
        </div>

        <div className="ags-wire-col ags-wire-col--mid">
          <LogPanel
            title="Main Orchestrator"
            entries={orchestratorLogs}
            emptyText="Idle — the orchestrator wakes on meaningful market events."
          />
          <LogPanel
            title="Subagents"
            entries={subagentLogs}
            emptyText="No subagent activity yet."
          />
        </div>

        <div className="ags-wire-col ags-wire-col--right">
          <MarketScannerPanel
            signals={scanner.signals}
            candlesBySymbol={scanner.candlesBySymbol}
            loading={scanner.loading}
            error={scanner.error}
          />
          <AgentsStatusPanel
            subagents={snapshot.subagents || []}
            halted={Boolean(snapshot.agent_state?.subagents_halted)}
            interactive={interactive}
            toggling={subagentsToggling}
            onToggle={() => void toggleSubagents()}
          />
          <MarketMonitorPanel monitors={snapshot.monitors || {}} />
        </div>
      </main>
    </div>
  )
}
