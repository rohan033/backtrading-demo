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
    <div className="ai-research-ui h-full overflow-auto p-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">AI Research</h1>
          <p className="mt-1 text-sm font-normal leading-relaxed text-text-secondary">
            Persisted research sessions with strategy suggestions and interactive deploy actions.
          </p>
        </div>
        <button
          type="button"
          onClick={startSession}
          disabled={creating}
          className="rounded-md bg-accent px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
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
        <div className="overflow-hidden rounded-lg border border-border bg-card text-sm">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-black/15 text-left">
                <th className="px-3.5 py-2.5 text-[10px] font-medium uppercase tracking-wider text-text-secondary">Session</th>
                <th className="px-3.5 py-2.5 text-[10px] font-medium uppercase tracking-wider text-text-secondary">Mode</th>
                <th className="px-3.5 py-2.5 text-[10px] font-medium uppercase tracking-wider text-text-secondary">Actions</th>
                <th className="px-3.5 py-2.5 text-[10px] font-medium uppercase tracking-wider text-text-secondary">Updated</th>
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
