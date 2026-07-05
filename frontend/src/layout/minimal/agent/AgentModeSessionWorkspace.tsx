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

type Props = {
  sessionId: string
  onSessionUpdate: (session: TradingSession) => void
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

export default function AgentModeSessionWorkspace({ sessionId, onSessionUpdate }: Props) {
  const [session, setSession] = useState<TradingSession | null>(null)
  const [stopping, setStopping] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null)

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

  return (
    <div className="am-ts-workspace">
      <header className="am-ts-header">
        <div className="am-ts-header__top">
          <div className="am-ts-header__title">
            <span className={`am-ts-badge am-ts-badge--${s.state}`}>{s.state}</span>
            <h1>{s.symbol || (agentRunning ? 'Discovering…' : 'No symbol')}</h1>
          </div>
          <div className="am-ts-header__meta">
            <span className={`am-ts-live${connected ? ' am-ts-live--on' : ''}`}>
              {connected ? 'Live' : polling ? 'Polling' : 'Offline'}
            </span>
            <span className="am-ts-pill">{s.account_env === 'live' ? 'Live' : 'Demo'}</span>
            <span className="am-ts-pill">{s.broker}</span>
            <button
              type="button"
              className="am-ts-stop"
              disabled={s.state === 'stopped' || stopping}
              onClick={() => { void handleStop() }}
            >
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          </div>
        </div>

        <div className="am-ts-stepper" aria-label="Session state pipeline">
          {SESSION_PIPELINE.map((step, idx) => {
            const done = idx < stepIdx
            const current = idx === stepIdx
            return (
              <div
                key={step}
                className={`am-ts-step${done ? ' am-ts-step--done' : ''}${current ? ' am-ts-step--current' : ''}`}
              >
                <span className="am-ts-step__dot" />
                <span className="am-ts-step__label">{step}</span>
              </div>
            )
          })}
        </div>

        <div className="am-ts-summary">
          <div className="am-ts-summary__item">
            <span className="am-ts-summary__label">Capital</span>
            <span>${s.max_capital.toLocaleString()}</span>
          </div>
          <div className="am-ts-summary__item">
            <span className="am-ts-summary__label">Target</span>
            <span>${s.profit_target.toLocaleString()}</span>
          </div>
          <div className="am-ts-summary__item am-ts-summary__item--grow">
            <span className="am-ts-summary__label">PnL</span>
            <div className="am-ts-progress">
              <div className="am-ts-progress__bar" style={{ width: `${pnlPct}%` }} />
              <span>${s.total_pnl.toFixed(2)}</span>
            </div>
          </div>
          {s.stopped_reason ? (
            <div className="am-ts-summary__stopped">{s.stopped_reason}</div>
          ) : null}
        </div>
      </header>

      <div className={`am-ts-body${showFocusPanel ? ' am-ts-body--split' : ''}`}>
        <TradingSessionActivityFeed
          events={events}
          turns={turns}
          agentRunning={agentRunning}
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
      </div>
    </div>
  )
}
