import { useCallback, useEffect, useState } from 'react'

import {
  agenticApiUnavailable,
  agenticSessionLabel,
  createAgenticSession,
  deleteAgenticSession,
  listAgenticSessions,
  type AgenticAccountEnv,
  type AgenticSession,
} from '@/lib/agenticSessions'
import { formatDbTimestamp, formatRelativeTimestamp } from '@/lib/datetime'
import { useUrlState } from '../useUrlState'
import AgenticSessionWorkspace from './AgenticSessionWorkspace'
import './AgenticSessions.css'

function formatSignedMoney(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  return `${sign}$${Math.abs(value).toFixed(2)}`
}

export default function AgenticSessions() {
  const { state, navigate } = useUrlState()
  const activeSessionId = state.agentic_session || ''

  const openSession = useCallback((sessionId: string) => {
    navigate({
      tab: 'agent',
      agent_panel: 'agentic',
      agentic_session: sessionId,
      trading_session: '',
      one_percent_session: '',
    })
  }, [navigate])

  const backToList = useCallback(() => {
    navigate({
      tab: 'agent',
      agent_panel: 'agentic',
      agentic_session: '',
    })
  }, [navigate])

  if (activeSessionId) {
    return (
      <AgenticSessionWorkspace
        key={activeSessionId}
        sessionId={activeSessionId}
        onBack={backToList}
      />
    )
  }

  return <AgenticSessionList onOpen={openSession} />
}

function AgenticSessionList({ onOpen }: { onOpen: (sessionId: string) => void }) {
  const [sessions, setSessions] = useState<AgenticSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [deletingId, setDeletingId] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setSessions(await listAgenticSessions())
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load sessions'
      setError(agenticApiUnavailable(message)
        ? 'Agentic trading API is unavailable — the backend has not started yet (make dev).'
        : message)
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleDelete = useCallback(async (session: AgenticSession) => {
    if (!window.confirm(`Delete ${agenticSessionLabel(session)}? This cannot be undone.`)) return
    setDeletingId(session.id)
    setError('')
    try {
      await deleteAgenticSession(session.id)
      setSessions(prev => prev.filter(row => row.id !== session.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete session')
    } finally {
      setDeletingId('')
    }
  }, [])

  return (
    <div className="ags-root">
      <div className="ags-list-panel">
        <div className="ags-list-head">
          <h2 className="ags-list-title">Agentic sessions</h2>
          <div className="ags-list-head__actions">
            <button
              type="button"
              className="ags-btn"
              onClick={() => void refresh()}
              disabled={loading}
            >
              Refresh
            </button>
            <button
              type="button"
              className="ags-btn ags-btn--primary"
              onClick={() => setCreateOpen(open => !open)}
            >
              {createOpen ? 'Cancel' : 'New session'}
            </button>
          </div>
        </div>

        {error ? <div className="ags-error">{error}</div> : null}

        {createOpen ? (
          <AgenticCreateForm
            onCreated={session => {
              setCreateOpen(false)
              onOpen(session.id)
            }}
          />
        ) : null}

        {loading ? (
          <div className="ags-empty">Loading sessions…</div>
        ) : sessions.length === 0 && !error ? (
          <div className="ags-empty">
            No agentic sessions yet. Create one to let the agent hunt and trade for you.
          </div>
        ) : (
          <ul className="ags-session-list">
            {sessions.map(session => (
              <li key={session.id}>
                <div
                  className="ags-session-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpen(session.id)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') onOpen(session.id)
                  }}
                >
                  <span className={`ags-status-pill ags-status-pill--${session.status}`}>
                    {session.status}
                  </span>
                  <span className="ags-session-row__name">{agenticSessionLabel(session)}</span>
                  <span className={`ags-env-badge ags-env-badge--${session.account_env}`}>
                    {session.account_env}
                  </span>
                  <span
                    className="ags-session-row__started"
                    title={formatDbTimestamp(session.started_at || session.created_at)}
                  >
                    {formatRelativeTimestamp(session.started_at || session.created_at)}
                  </span>
                  <span
                    className={`ags-session-row__pnl ${
                      session.stats.realized_pnl > 0
                        ? 'ags-pos'
                        : session.stats.realized_pnl < 0
                          ? 'ags-neg'
                          : ''
                    }`}
                  >
                    {formatSignedMoney(session.stats.realized_pnl)}
                  </span>
                  {session.status === 'stopped' ? (
                    <button
                      type="button"
                      className="ags-session-row__delete"
                      title="Delete session"
                      disabled={deletingId === session.id}
                      onClick={event => {
                        event.stopPropagation()
                        void handleDelete(session)
                      }}
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function AgenticCreateForm({ onCreated }: { onCreated: (session: AgenticSession) => void }) {
  const [name, setName] = useState('')
  const [accountEnv, setAccountEnv] = useState<AgenticAccountEnv>('demo')
  const [startBalance, setStartBalance] = useState('')
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = useCallback(async () => {
    setSubmitting(true)
    setError('')
    const balance = startBalance.trim() === '' ? undefined : Number(startBalance)
    if (balance != null && (!Number.isFinite(balance) || balance <= 0)) {
      setError('Start balance must be a positive number.')
      setSubmitting(false)
      return
    }
    try {
      const session = await createAgenticSession({
        name: name.trim() || undefined,
        prompt: prompt.trim() || undefined,
        account_env: accountEnv,
        start_balance: balance,
      })
      onCreated(session)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create session'
      setError(agenticApiUnavailable(message)
        ? 'Agentic trading API is unavailable — the backend has not started yet (make dev).'
        : message)
      setSubmitting(false)
    }
  }, [accountEnv, name, onCreated, prompt, startBalance])

  return (
    <form
      className="ags-create"
      onSubmit={event => {
        event.preventDefault()
        void handleSubmit()
      }}
    >
      <div className="ags-create__grid">
        <label className="ags-field">
          <span className="ags-field__label">Name (optional)</span>
          <input
            className="ags-input"
            type="text"
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder="Morning momentum run"
          />
        </label>
        <div className="ags-field">
          <span className="ags-field__label">Account</span>
          <div className="ags-segment" role="radiogroup" aria-label="Account environment">
            {(['demo', 'live'] as const).map(env => (
              <button
                key={env}
                type="button"
                role="radio"
                aria-checked={accountEnv === env}
                className={`ags-segment__btn${accountEnv === env ? ' ags-segment__btn--active' : ''}`}
                onClick={() => setAccountEnv(env)}
              >
                {env}
              </button>
            ))}
          </div>
        </div>
        <label className="ags-field">
          <span className="ags-field__label">Start balance $ (optional)</span>
          <input
            className="ags-input"
            type="number"
            min="0"
            step="any"
            value={startBalance}
            onChange={event => setStartBalance(event.target.value)}
            placeholder="1000"
          />
        </label>
      </div>
      <label className="ags-field">
        <span className="ags-field__label">Instructions for the agent (optional)</span>
        <textarea
          className="ags-input ags-textarea"
          value={prompt}
          onChange={event => setPrompt(event.target.value)}
          placeholder="Anything the agent should know — tickers to avoid, sectors to favor, risk appetite…"
          rows={3}
        />
      </label>
      {error ? <div className="ags-error">{error}</div> : null}
      <div className="ags-create__footer">
        <button type="submit" className="ags-btn ags-btn--primary" disabled={submitting}>
          {submitting ? 'Starting…' : 'Start session'}
        </button>
      </div>
    </form>
  )
}
