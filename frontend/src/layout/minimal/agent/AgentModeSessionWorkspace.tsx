import { useCallback, useEffect, useMemo, useState } from 'react'

import { useTradingSessionEvents } from '@/hooks/useTradingSessionEvents'
import {
  getTradingSession,
  SESSION_PIPELINE,
  stopTradingSession,
  type TradingSession,
  type TradingSessionState,
} from '@/lib/tradingSessions'
import { latestSessionPicks } from '@/lib/tradingSessionSurfaces'
import type { A2uiStockPick } from '@/lib/agentA2uiCatalog'

import TradingSessionActivityFeed from './TradingSessionActivityFeed'
import TradingSessionFocusPanel from './TradingSessionFocusPanel'
import TradingSessionStatusDrawer from './TradingSessionStatusDrawer'
import SessionPipelineFlow from './SessionPipelineFlow'

type Props = {
  sessionId: string
  onSessionUpdate: (session: TradingSession) => void
  onOpenSessions?: () => void
  onCreateSession?: () => void
}

function stateStepIndex(state: TradingSessionState): number {
  const idx = SESSION_PIPELINE.indexOf(state)
  return idx >= 0 ? idx : 0
}

function pickSymbolMatch(pick: A2uiStockPick, symbol: string): boolean {
  const target = symbol.toUpperCase()
  const root = pick.symbol.toUpperCase().split('-')[0]
  return pick.symbol.toUpperCase() === target || root === target.split('-')[0]
}

export default function AgentModeSessionWorkspace({
  sessionId,
  onSessionUpdate,
  onOpenSessions,
  onCreateSession,
}: Props) {
  const [session, setSession] = useState<TradingSession | null>(null)
  const [stopping, setStopping] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null)
  const [statusDrawerOpen, setStatusDrawerOpen] = useState(false)

  const { events, turns, connected, polling, agentRunning } = useTradingSessionEvents(sessionId)
  const picks = useMemo(() => latestSessionPicks(events), [events])

  const refreshSession = useCallback(async () => {
    try {
      const row = await getTradingSession(sessionId)
      setSession(row)
      onSessionUpdate(row)
      setLoadError('')
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load session')
    }
  }, [onSessionUpdate, sessionId])

  useEffect(() => {
    void refreshSession()
  }, [refreshSession])

  useEffect(() => {
    if (!events.length) return
    void refreshSession()
  }, [events.length, refreshSession])

  useEffect(() => {
    if (session?.symbol) {
      setSelectedSymbol(session.symbol)
    }
  }, [session?.symbol])

  useEffect(() => {
    if (selectedSymbol || !picks?.length) return
    setSelectedSymbol(picks[0].symbol)
  }, [picks, selectedSymbol])

  const activePick = useMemo(() => {
    if (!selectedSymbol && !session?.symbol) return null
    const sym = selectedSymbol || session?.symbol || ''
    const fromPicks = picks?.find(pick => pickSymbolMatch(pick, sym))
    if (fromPicks) return fromPicks
    if (!session?.symbol) return null
    return {
      symbol: session.symbol,
      token: session.token ?? undefined,
      exchange: session.exchange ?? undefined,
      name: session.symbol.split('-')[0],
    } satisfies A2uiStockPick
  }, [picks, selectedSymbol, session?.exchange, session?.symbol, session?.token])

  const showFocusPanel = Boolean(picks?.length || activePick?.symbol)

  const handleStop = useCallback(async () => {
    setStopping(true)
    try {
      const row = await stopTradingSession(sessionId)
      setSession(row)
      onSessionUpdate(row)
    } finally {
      setStopping(false)
    }
  }, [onSessionUpdate, sessionId])

  if (!session && !loadError) {
    return <div className="am-chat-empty">Loading session…</div>
  }

  if (loadError && !session) {
    return <div className="am-thread-list-error">{loadError}</div>
  }

  const s = session!
  const stepIdx = stateStepIndex(s.state)
  const pnlPct = s.profit_target > 0 ? Math.min(100, (s.total_pnl / s.profit_target) * 100) : 0
  const symbolLabel = s.symbol?.split('-')[0] || (agentRunning ? 'Discovering…' : 'No symbol')

  return (
    <div className="am-ts-workspace">
      <header className="am-ts-header am-ts-header--compact">
        <div className="am-ts-header__row">
          <div className="am-ts-header__left">
            {onOpenSessions ? (
              <button type="button" className="am-ts-nav-btn" onClick={onOpenSessions}>
                Sessions
              </button>
            ) : null}
            {onCreateSession ? (
              <button
                type="button"
                className="am-ts-nav-btn am-ts-nav-btn--icon"
                onClick={onCreateSession}
                aria-label="New session"
                title="New session"
              >
                +
              </button>
            ) : null}
            <span className={`am-ts-badge am-ts-badge--${s.state}`}>{s.state}</span>
            <span className="am-ts-header__symbol">{symbolLabel}</span>
          </div>

          <div className="am-ts-header__stats" aria-label="Session goals">
            <span
              className="am-ts-stat"
              title="Requested max capital. Actual deployed amount will sync from portfolio/orders once a trade is placed."
            >
              <span className="am-ts-stat__label">Req cap</span>
              <span className="am-ts-stat__val">${s.max_capital.toLocaleString()}</span>
            </span>
            {s.actual_capital_used != null && s.actual_capital_used > 0 ? (
              <span className="am-ts-stat" title="Capital deployed per portfolio/orders">
                <span className="am-ts-stat__label">Used</span>
                <span className="am-ts-stat__val">${s.actual_capital_used.toLocaleString()}</span>
              </span>
            ) : null}
            <span className="am-ts-stat">
              <span className="am-ts-stat__label">Target</span>
              <span className="am-ts-stat__val">${s.profit_target.toLocaleString()}</span>
            </span>
            <span className="am-ts-stat am-ts-stat--pnl">
              <span className="am-ts-stat__label">PnL</span>
              <span className="am-ts-stat__val">${s.total_pnl.toFixed(2)}</span>
              <span className="am-ts-stat__bar" aria-hidden>
                <span className="am-ts-stat__bar-fill" style={{ width: `${pnlPct}%` }} />
              </span>
            </span>
          </div>

          <div className="am-ts-header__meta">
            <span className={`am-ts-live${connected ? ' am-ts-live--on' : ''}`} title="Event stream">
              {connected ? 'Live' : polling ? 'Poll' : 'Off'}
            </span>
            <span className="am-ts-pill">{s.account_env === 'live' ? 'Live' : 'Demo'}</span>
            <span className="am-ts-pill">{s.broker}</span>
            <button
              type="button"
              className="am-ts-stop"
              disabled={s.state === 'stopped' || stopping}
              onClick={() => { void handleStop() }}
            >
              {stopping ? '…' : 'Stop'}
            </button>
          </div>
        </div>

        <div className="am-ts-header__row am-ts-header__row--sub">
          <SessionPipelineFlow
            state={s.state}
            stepIdx={stepIdx}
          />
        </div>
      </header>

      <div className={`am-ts-body${showFocusPanel ? ' am-ts-body--split' : ''}`}>
        <TradingSessionActivityFeed
          events={events}
          turns={turns}
          agentRunning={agentRunning}
          onOpenStatusDrawer={() => setStatusDrawerOpen(true)}
        />
        {showFocusPanel ? (
          <TradingSessionFocusPanel
            picks={picks}
            selectedSymbol={selectedSymbol || s.symbol || null}
            onPickSymbol={setSelectedSymbol}
            broker={s.broker}
            accountEnv={s.account_env}
            fallbackPick={activePick}
          />
        ) : null}
        <TradingSessionStatusDrawer
          open={statusDrawerOpen}
          onClose={() => setStatusDrawerOpen(false)}
          events={events}
        />
      </div>
    </div>
  )
}
