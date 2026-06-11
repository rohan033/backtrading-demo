import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import {
  createResearchSession,
  listResearchSessions,
  type AiResearchSession,
} from '../../lib/aiResearch'
import { formatDbTimestamp } from '../../lib/datetime'
import './ai-research.css'

export function AiResearchListPage() {
  const navigate = useNavigate()
  const [sessions, setSessions] = useState<AiResearchSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setSessions(await listResearchSessions())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load AI sessions')
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const startSession = async () => {
    setCreating(true)
    setError('')
    try {
      const session = await createResearchSession()
      navigate(`/learn/research/${encodeURIComponent(session.session_id)}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="ai-research-ui h-full overflow-auto p-6 animate-fade-in">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-accent/30 to-accent-2/30 font-display text-xs font-extrabold text-text-primary ring-1 ring-inset ring-white/10">
            AI
          </span>
          <div>
            <h1 className="font-display text-xl font-bold tracking-tightest text-text-primary">AI Research</h1>
            <p className="mt-1 text-sm leading-relaxed text-text-secondary">
              Persisted research sessions with strategy suggestions and interactive deploy actions.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={startSession}
          disabled={creating}
          className="rounded-md bg-accent px-4 py-2 text-[12px] font-bold text-primary shadow-[0_4px_14px_rgb(var(--c-accent)/0.3)] transition-transform hover:-translate-y-px disabled:opacity-50"
        >
          {creating ? 'Starting…' : 'New session'}
        </button>
      </div>

      {error ? (
        <div className="mb-4 rounded border border-red/40 bg-red/10 px-4 py-3 text-sm text-red">{error}</div>
      ) : null}

      {loading ? (
        <div className="rounded border border-dashed border-border p-8 text-center text-sm text-text-secondary">
          Loading sessions…
        </div>
      ) : sessions.length ? (
        <div className="overflow-hidden rounded-lg border border-border bg-card text-sm shadow-panel">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-secondary text-left">
                <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-secondary">Session</th>
                <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-secondary">Mode</th>
                <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-secondary">Actions</th>
                <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-secondary">Updated</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map(session => (
                <tr key={session.session_id} className="border-b border-border hover:bg-white/[0.02]">
                  <td className="px-3.5 py-2.5">
                    <Link
                      to={`/learn/research/${encodeURIComponent(session.session_id)}`}
                      className="font-medium text-accent hover:underline"
                    >
                      {session.title}
                    </Link>
                    <div className="mt-0.5 font-mono text-[10px] text-text-secondary">{session.session_id}</div>
                  </td>
                  <td className="px-3.5 py-2.5 uppercase text-text-secondary">{session.interaction_mode}</td>
                  <td className="px-3.5 py-2.5 text-text-secondary">{(session.actions || []).length}</td>
                  <td className="px-3.5 py-2.5 whitespace-nowrap text-text-secondary">
                    {formatDbTimestamp(session.last_message_at || session.updated_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded border border-dashed border-border p-8 text-center text-sm text-text-secondary">
          No research sessions yet. Start one to explore stocks and strategy ideas with AI.
        </div>
      )}
    </div>
  )
}
