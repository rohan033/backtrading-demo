import { useMemo, useState } from 'react'

import { formatDbTimestamp } from '../../../lib/datetime'
import {
  isTerminalOnePercentState,
  onePercentSessionLabel,
  type OnePercentSession,
  type OnePercentSessionDetail,
} from '@/lib/onePercentSessions'
import OnePercentSessionStarter from './OnePercentSessionStarter'
import OnePercentSessionWorkspace from './OnePercentSessionWorkspace'

type Props = {
  sessions: OnePercentSession[]
  activeSessionId: string
  loading: boolean
  listError?: string
  onRetryLoad?: () => void
  onSelect: (sessionId: string) => void
  onCreated: (session: OnePercentSessionDetail) => void
  onSessionUpdate: (session: OnePercentSession) => void
  onDelete?: (sessionId: string) => void
  deletingId?: string
  onClearActive?: () => void
}

export default function OnePercentTradesPanel({
  sessions,
  activeSessionId,
  loading,
  listError,
  onRetryLoad,
  onSelect,
  onCreated,
  onSessionUpdate,
  onDelete,
  deletingId,
  onClearActive,
}: Props) {
  const [configOpen, setConfigOpen] = useState(true)

  const runningSession = useMemo(
    () => sessions.find(row => !isTerminalOnePercentState(row.state)) || null,
    [sessions],
  )

  const activeSession = useMemo(
    () => sessions.find(row => row.id === activeSessionId) || null,
    [activeSessionId, sessions],
  )

  const frozenSession = runningSession
    || (activeSession && !isTerminalOnePercentState(activeSession.state) ? activeSession : null)

  return (
    <div className={`opc-shell${configOpen ? '' : ' opc-shell--config-collapsed'}`}>
      <section className="opc-shell__main" aria-label="1pc trades activity">
        <aside className="opc-shell__sessions" aria-label="1pc session list">
          <div className="opc-shell__sessions-head">
            <strong>Sessions</strong>
            {activeSessionId && onClearActive ? (
              <button type="button" className="opc-shell__sessions-clear" onClick={onClearActive}>
                Clear
              </button>
            ) : null}
          </div>
          <div className="opc-shell__sessions-body">
            {listError ? (
              <div className="am-thread-list-error opc-list-error">
                <span>{listError}</span>
                {onRetryLoad ? (
                  <button type="button" className="opc-shell__sessions-clear" onClick={onRetryLoad}>
                    Retry
                  </button>
                ) : null}
              </div>
            ) : null}
            {loading ? (
              <div className="am-empty-note">Loading…</div>
            ) : sessions.length ? (
              <ul className="opc-session-list">
                {sessions.map(session => {
                  const active = session.id === activeSessionId
                  const terminal = isTerminalOnePercentState(session.state)
                  return (
                    <li key={session.id}>
                      <div
                        className={`opc-session-list__item${active ? ' opc-session-list__item--active' : ''}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => onSelect(session.id)}
                        onKeyDown={event => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            onSelect(session.id)
                          }
                        }}
                      >
                        <div className="opc-session-list__title">
                          <span className={`am-ts-badge am-ts-badge--${terminal ? 'stopped' : 'monitor'}`}>
                            {session.state}
                          </span>
                          <span className="opc-session-list__label">{onePercentSessionLabel(session)}</span>
                          {onDelete ? (
                            <button
                              type="button"
                              className="am-thread-delete"
                              aria-label={`Delete ${onePercentSessionLabel(session)}`}
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
                        <div className="opc-session-list__meta">
                          {session.account_env.toUpperCase()}
                          {session.active_symbol ? ` · ${session.active_symbol}` : ''}
                          {' · '}
                          P&amp;L {Number(session.cumulative_pnl || 0).toFixed(2)}
                        </div>
                        <div className="opc-session-list__meta">
                          {formatDbTimestamp(session.updated_at)}
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <div className="am-empty-note">
                No sessions yet. Start one from Configuration →
              </div>
            )}
          </div>
        </aside>

        <div className="opc-shell__detail">
          {activeSessionId ? (
            <OnePercentSessionWorkspace
              key={activeSessionId}
              sessionId={activeSessionId}
              onSessionUpdate={onSessionUpdate}
            />
          ) : (
            <div className="opc-activity-home">
              <div className="opc-activity-home__head">
                <div className="opc-starter__eyebrow">1pc trades</div>
                <strong>Select a session</strong>
                <p>
                  Pick a session from the list on the left, or start a new one in Configuration.
                </p>
              </div>
            </div>
          )}
        </div>
      </section>

      <aside className="opc-shell__config" aria-label="1pc configuration">
        {configOpen ? (
          <>
            <div className="opc-shell__config-head">
              <div>
                <span className="opc-shell__config-kicker">1pc trades</span>
                <strong>Configuration</strong>
              </div>
              <button
                type="button"
                className="opc-shell__collapse"
                onClick={() => setConfigOpen(false)}
                aria-label="Collapse configuration"
                title="Collapse"
              >
                Hide
              </button>
            </div>
            <div className="opc-shell__config-body">
              <OnePercentSessionStarter
                embedded
                onCreated={onCreated}
                runningSession={frozenSession}
                frozen={Boolean(frozenSession)}
                frozenConfig={frozenSession?.config || null}
                frozenAccountEnv={frozenSession?.account_env || null}
              />
            </div>
          </>
        ) : (
          <button
            type="button"
            className="opc-shell__config-tab"
            onClick={() => setConfigOpen(true)}
            title="Show configuration"
          >
            <span>Configuration</span>
          </button>
        )}
      </aside>
    </div>
  )
}
