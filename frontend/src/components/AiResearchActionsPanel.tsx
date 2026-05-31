import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { PanelRightOpen, X } from 'lucide-react'

import { startControlledExecution } from '../ExecutionWorkspace'
import {
  type AiResearchAction,
  type AiResearchSession,
  getResearchSession,
  upsertResearchAction,
} from '../lib/aiResearch'
import {
  filterSessionExecutions,
  resolveExecutionIdForAction,
  type ResearchSessionExecution,
} from '../lib/researchActionLinks'
import { EXECUTION_SOURCE_AI_RESEARCH } from '../lib/executionSources'
import '../pages/learn/ai-research.css'

const CONTROL_API = '/api/control'

function actionTone(type: string) {
  if (type.includes('strategy')) return 'text-violet-300'
  if (type.includes('execution')) return 'text-green'
  if (type === 'source') return 'text-accent'
  return 'text-text-secondary'
}

function ActionSummaryDialog({
  open,
  title,
  summary,
  sources,
  onClose,
}: {
  open: boolean
  title: string
  summary?: string | null
  sources?: unknown[]
  onClose: () => void
}) {
  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[70vh] w-full max-w-md overflow-auto rounded-xl border border-border bg-card p-4 shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wide text-accent">Research summary</div>
            <div className="mt-1 text-sm font-semibold text-text-primary">{title}</div>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-text-secondary hover:text-text-primary">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-secondary">
          {summary?.trim() || 'No research summary yet for this session.'}
        </p>
        {(sources || []).length ? (
          <div className="mt-4 border-t border-border pt-3">
            <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-text-secondary">Sources</div>
            <ul className="space-y-1 text-xs text-text-secondary">
              {(sources || []).map((source, index) => (
                <li key={index}>{typeof source === 'string' ? source : JSON.stringify(source)}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function StrategyActionEditor({
  payload,
  onChange,
}: {
  payload: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}) {
  const fields = [
    ['broker', 'Broker'],
    ['symbol', 'Symbol'],
    ['token', 'Token'],
    ['exchange', 'Exchange'],
    ['close_price', 'Close price'],
    ['long_percent', 'Take profit %'],
    ['short_percent', 'Stop loss %'],
    ['initial_threshold', 'Entry threshold %'],
    ['max_available_capital', 'Capital'],
  ] as const

  return (
    <div className="mt-3 grid grid-cols-2 gap-2">
      {fields.map(([key, label]) => (
        <label key={key} className="col-span-1 block">
          <span className="text-[9px] uppercase tracking-wide text-text-secondary">{label}</span>
          <input
            value={String(payload[key] ?? '')}
            onChange={e => onChange({ ...payload, [key]: e.target.value })}
            className="mt-1 w-full rounded border border-border bg-card px-2 py-1.5 text-[11px] text-text-primary outline-none focus:border-accent"
          />
        </label>
      ))}
    </div>
  )
}

function ActionCard({
  action,
  sessionId,
  sessionSummary,
  resolvedExecutionId,
  onSessionUpdated,
}: {
  action: AiResearchAction
  sessionId: string
  sessionSummary?: string | null
  resolvedExecutionId?: string | null
  onSessionUpdated: (session: AiResearchSession) => void
}) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [draftPayload, setDraftPayload] = useState<Record<string, unknown>>(action.payload || {})

  const buildExecutionBody = (options: { schedule?: boolean; startImmediately?: boolean }) => {
    const payload = editing ? draftPayload : (action.payload || {})
    return {
      source_id: EXECUTION_SOURCE_AI_RESEARCH,
      source_meta_id: sessionId,
      broker: String(payload.broker || 'angel'),
      account_env: String(payload.account_env || 'live'),
      strategy_name: String(payload.strategy_name || 'one-percent'),
      symbol: String(payload.symbol || ''),
      token: String(payload.token || ''),
      exchange: String(payload.exchange || 'NSE'),
      close_price: Number(payload.close_price || 0),
      long_percent: Number(payload.long_percent || 1),
      short_percent: Number(payload.short_percent || 10),
      initial_threshold: Number(payload.initial_threshold || 0.2),
      max_available_capital: Number(payload.max_available_capital || 100000),
      allow_partial_stocks: Boolean(payload.allow_partial_stocks),
      schedule_enabled: Boolean(options.schedule),
      scheduled_date: options.schedule ? String(payload.scheduled_date || '') || null : null,
      start_immediately: Boolean(options.startImmediately),
    }
  }

  const persistAction = async (patch: Partial<AiResearchAction>) => {
    const session = await upsertResearchAction(sessionId, {
      ...action,
      ...patch,
      payload: editing ? draftPayload : (action.payload || {}),
    })
    onSessionUpdated(session)
  }

  const run = async (mode: 'save' | 'schedule' | 'deploy') => {
    setBusy(mode)
    setError('')
    try {
      const body = buildExecutionBody({
        schedule: mode === 'schedule',
        startImmediately: mode === 'deploy',
      })
      if (!body.symbol || !body.token || !body.close_price) {
        throw new Error('Strategy payload needs symbol, token, and close price')
      }
      const res = await fetch(`${CONTROL_API}/executions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Failed to save execution')
      const executionId = data.data.execution_id as string
      if (mode === 'deploy') {
        await startControlledExecution(executionId)
      }
      await persistAction({
        status: mode === 'save' ? 'saved' : mode === 'schedule' ? 'scheduled' : 'running',
        payload: {
          ...(editing ? draftPayload : action.payload),
          execution_id: executionId,
        },
      })
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusy('')
    }
  }

  const executionId = String(
    (action.payload || {}).execution_id || resolvedExecutionId || '',
  ).trim()
  const strategyHref = executionId
    ? `/trade/strategies/${encodeURIComponent(executionId)}`
    : null
  const isStrategy = action.type.includes('strategy') || Boolean((action.payload || {}).symbol)

  return (
    <>
      <div className="rounded-lg border border-border bg-card/70 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className={`text-[10px] font-bold uppercase tracking-wide ${actionTone(action.type)}`}>
              {action.type.replace(/_/g, ' ')}
            </div>
            <div className="mt-1 text-sm font-semibold text-text-primary">{action.title}</div>
            <button
              type="button"
              title="Research summary"
              onClick={() => setSummaryOpen(true)}
              className="mt-1 text-[10px] font-semibold text-accent hover:underline"
            >
              Info
            </button>
            {action.status ? (
              <div className="mt-1 text-[10px] uppercase text-text-secondary">{action.status}</div>
            ) : null}
            {executionId ? (
              <div className="mt-1 truncate font-mono text-[10px] text-text-secondary/80">{executionId}</div>
            ) : null}
          </div>
        </div>

        {strategyHref ? (
          <Link
            to={strategyHref}
            className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-[11px] font-semibold text-accent transition-colors hover:bg-accent/20"
          >
            View strategy
          </Link>
        ) : isStrategy ? (
          <p className="mt-2 text-[10px] text-text-secondary/80">
            Save or deploy this action to link it to a strategy page.
          </p>
        ) : null}

        {(action.sources || []).length ? (
          <ul className="mt-2 space-y-1 text-[10px] text-text-secondary">
            {(action.sources || []).slice(0, 4).map((source, index) => (
              <li key={index} className="truncate">
                {typeof source === 'string' ? source : JSON.stringify(source)}
              </li>
            ))}
          </ul>
        ) : null}

        {isStrategy && editing ? (
          <StrategyActionEditor payload={draftPayload} onChange={setDraftPayload} />
        ) : null}

        {isStrategy ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() => run('save')}
              className="rounded border border-border bg-card px-2.5 py-1.5 text-[10px] font-bold text-text-primary hover:border-accent/40 disabled:opacity-50"
            >
              {busy === 'save' ? 'Saving…' : 'Save strategy'}
            </button>
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() => run('schedule')}
              className="rounded border border-accent/40 bg-accent/10 px-2.5 py-1.5 text-[10px] font-bold text-accent hover:bg-accent/20 disabled:opacity-50"
            >
              {busy === 'schedule' ? 'Scheduling…' : 'Schedule'}
            </button>
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() => run('deploy')}
              className="rounded bg-green px-2.5 py-1.5 text-[10px] font-bold text-white disabled:opacity-50"
            >
              {busy === 'deploy' ? 'Deploying…' : 'Deploy'}
            </button>
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() => {
                if (editing) {
                  persistAction({ payload: draftPayload })
                }
                setEditing(prev => !prev)
              }}
              className="rounded border border-border px-2.5 py-1.5 text-[10px] font-bold text-text-secondary hover:text-text-primary disabled:opacity-50"
            >
              {editing ? 'Done editing' : 'Edit strategy'}
            </button>
          </div>
        ) : null}

        {error ? <p className="mt-2 text-[10px] text-red">{error}</p> : null}
      </div>

      <ActionSummaryDialog
        open={summaryOpen}
        title={action.title}
        summary={sessionSummary}
        sources={action.sources}
        onClose={() => setSummaryOpen(false)}
      />
    </>
  )
}

export default function AiResearchActionsPanel({
  session,
  onClose,
  onSessionUpdated,
}: {
  session: AiResearchSession
  onClose?: () => void
  onSessionUpdated: (session: AiResearchSession) => void
}) {
  const [sessionExecutions, setSessionExecutions] = useState<ResearchSessionExecution[]>([])
  const onSessionUpdatedRef = useRef(onSessionUpdated)

  useEffect(() => {
    onSessionUpdatedRef.current = onSessionUpdated
  }, [onSessionUpdated])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const [freshSession, execRes] = await Promise.all([
          getResearchSession(session.session_id),
          fetch('/api/control/executions'),
        ])
        if (cancelled) return
        onSessionUpdatedRef.current(freshSession)
        const execPayload = await execRes.json().catch(() => null)
        if (execRes.ok && execPayload?.status) {
          setSessionExecutions(
            filterSessionExecutions(execPayload.data || [], session.session_id),
          )
        }
      } catch {
        if (!cancelled) setSessionExecutions([])
      }
    })()

    return () => {
      cancelled = true
    }
  }, [session.session_id])

  const actions = useMemo(() => session.actions || [], [session.actions])

  const resolvedByActionId = useMemo(() => {
    const claimed = new Set<string>()
    const map = new Map<string, string>()
    for (const action of actions) {
      const id = resolveExecutionIdForAction(action, sessionExecutions, claimed)
      if (id) {
        map.set(action.id, id)
        claimed.add(id)
      }
    }
    return map
  }, [actions, sessionExecutions])

  return (
    <aside className="ai-research-ui fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-border bg-secondary shadow-2xl">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <div className="text-[10px] font-medium uppercase tracking-wider text-accent">Research actions</div>
          <div className="mt-0.5 text-sm font-medium tracking-tight">{session.title}</div>
        </div>
        {onClose ? (
          <button type="button" onClick={onClose} className="rounded p-1 text-text-secondary hover:text-text-primary">
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4 space-y-3">
        {actions.length ? (
          actions.map(action => (
            <ActionCard
              key={action.id}
              action={action}
              sessionId={session.session_id}
              sessionSummary={session.summary}
              resolvedExecutionId={resolvedByActionId.get(action.id)}
              onSessionUpdated={onSessionUpdated}
            />
          ))
        ) : (
          <div className="rounded border border-dashed border-border p-6 text-center text-sm text-text-secondary">
            Actions from AI suggestions, executions, and sources will appear here as the session progresses.
          </div>
        )}
      </div>
    </aside>
  )
}

export function ActionsToggleButton({
  actionCount,
  onClick,
}: {
  actionCount: number
  onClick: () => void
}) {
  const tooltip =
    actionCount > 0
      ? `${actionCount} research action${actionCount === 1 ? '' : 's'}`
      : 'No research actions yet'

  return (
    <button
      type="button"
      title={tooltip}
      aria-label={tooltip}
      onClick={onClick}
      className="relative rounded-lg border border-border/70 bg-card/80 p-2 text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
    >
      <PanelRightOpen className="h-4 w-4" />
      {actionCount > 0 ? (
        <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold text-white">
          {actionCount > 9 ? '9+' : actionCount}
        </span>
      ) : null}
    </button>
  )
}
