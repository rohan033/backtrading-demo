import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import LiveLogPanel from '../../components/LiveLogPanel'
import {
  formatDbTimestamp,
  formatRelativeTimestamp,
  heartbeatAgeSeconds,
} from '../../lib/datetime'

const REFRESH_MS = 10_000
const STALE_HEARTBEAT_SECONDS = 15

type EngineRecord = {
  id: string
  label?: string
  broker?: string
  symbol?: string
  strategy_name?: string
  account_env?: string
  status?: string
  port?: number
  pid?: number | null
  heartbeat_count?: number
  last_seen_at?: string | null
  started_at?: string | null
  stopped_at?: string | null
  metadata?: {
    source?: string
    executor_payload?: { executor_id?: string; symbol?: string }
    log_file?: string
    ws_connections?: number
    executor_count?: number
    strategy_name?: string
    symbol?: string
  } | null
  last_heartbeat?: {
    status?: string
    pid?: number
    broker?: string
    account_env?: string
    executor_count?: number
    metadata?: {
      ws_connections?: number
      symbol?: string
      strategy_name?: string
    }
  } | null
}

type EngineRow = EngineRecord & {
  heartbeatAgeSec: number | null
  heartbeatFresh: boolean
  isControlled: boolean
  strategyLabel: string
  symbolLabel: string
  logFile: string | null
  wsClients: number | null
  executorCount: number | null
}

function isControlledExecution(engine: EngineRecord): boolean {
  if (engine.id === 'local-live-engine') return false
  const metadata = engine.metadata || {}
  if (metadata.source === 'controlled_execution') return true
  return Boolean(metadata.executor_payload)
}

function normalizeEngine(engine: EngineRecord): EngineRow {
  const heartbeat = engine.last_heartbeat || {}
  const heartbeatMeta = heartbeat.metadata || {}
  const metadata = engine.metadata || {}
  const heartbeatAgeSec = heartbeatAgeSeconds(engine.last_seen_at)
  const status = String(engine.status || 'unknown').toLowerCase()
  const fresh = heartbeatAgeSec != null && heartbeatAgeSec <= STALE_HEARTBEAT_SECONDS

  return {
    ...engine,
    heartbeatAgeSec,
    heartbeatFresh: ['running', 'starting'].includes(status) ? fresh : false,
    isControlled: isControlledExecution(engine),
    strategyLabel:
      engine.label
      || metadata.executor_payload?.executor_id
      || engine.strategy_name
      || engine.id,
    symbolLabel:
      engine.symbol
      || metadata.executor_payload?.symbol
      || heartbeatMeta.symbol
      || '—',
    logFile: typeof metadata.log_file === 'string' ? metadata.log_file : null,
    wsClients:
      heartbeatMeta.ws_connections
      ?? metadata.ws_connections
      ?? null,
    executorCount:
      heartbeat.executor_count
      ?? heartbeatMeta.executor_count
      ?? null,
  }
}

function statusTone(status: string) {
  const normalized = status.toLowerCase()
  if (normalized === 'running') return 'bg-green/15 text-green'
  if (normalized === 'starting') return 'bg-accent/15 text-accent'
  if (normalized === 'stale') return 'bg-amber-400/15 text-amber-400'
  if (normalized === 'stopped' || normalized === 'failed') return 'bg-red/15 text-red'
  if (normalized === 'pending') return 'bg-text-secondary/15 text-text-secondary'
  return 'bg-text-secondary/15 text-text-secondary'
}

function heartbeatTone(row: EngineRow) {
  if (!['running', 'starting', 'stale'].includes(String(row.status || '').toLowerCase())) {
    return 'text-text-secondary'
  }
  if (row.heartbeatAgeSec == null) return 'text-red'
  if (row.heartbeatAgeSec <= STALE_HEARTBEAT_SECONDS) return 'text-green'
  return 'text-amber-400'
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3.5">
      <div className="mb-1.5 text-[10px] uppercase tracking-widest text-text-secondary">{label}</div>
      <div className="font-mono text-xl font-bold">{value}</div>
      {hint ? <div className="mt-1 text-[10px] text-text-secondary">{hint}</div> : null}
    </div>
  )
}

export default function LiveServersPage() {
  const [engines, setEngines] = useState<EngineRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null)
  const [tick, setTick] = useState(0)
  const [logTarget, setLogTarget] = useState<EngineRow | null>(null)

  const loadEngines = useCallback(async () => {
    try {
      const res = await fetch('/api/control/engines')
      const data = await res.json()
      if (!res.ok || !data.status) {
        throw new Error(data.detail || data.message || 'Failed to load engines')
      }
      const rows = (data.data || [])
        .map((engine: EngineRecord) => normalizeEngine(engine))
        .sort((a: EngineRow, b: EngineRow) => {
          const liveRank = (row: EngineRow) => {
            const status = String(row.status || '').toLowerCase()
            if (status === 'running') return 0
            if (status === 'starting') return 1
            if (status === 'stale') return 2
            if (status === 'pending') return 3
            return 4
          }
          const rankDelta = liveRank(a) - liveRank(b)
          if (rankDelta !== 0) return rankDelta
          const seenA = a.last_seen_at || ''
          const seenB = b.last_seen_at || ''
          return seenB.localeCompare(seenA)
        })
      setEngines(rows)
      setError('')
      setLastUpdatedAt(new Date())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load engines')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadEngines()
    const refreshId = window.setInterval(loadEngines, REFRESH_MS)
    const tickId = window.setInterval(() => setTick(value => value + 1), 1000)
    return () => {
      window.clearInterval(refreshId)
      window.clearInterval(tickId)
    }
  }, [loadEngines])

  const metrics = useMemo(() => {
    void tick
    const running = engines.filter(row => row.status === 'running').length
    const starting = engines.filter(row => row.status === 'starting').length
    const stale = engines.filter(row => row.status === 'stale').length
    const live = engines.filter(row => ['running', 'starting'].includes(String(row.status || '')))
    const fresh = live.filter(row => row.heartbeatFresh).length
    const totalHeartbeats = engines.reduce((sum, row) => sum + Number(row.heartbeat_count || 0), 0)
    return { running, starting, stale, live: live.length, fresh, totalHeartbeats }
  }, [engines, tick])

  const liveRows = useMemo(
    () => engines.filter(row => ['running', 'starting', 'stale'].includes(String(row.status || '').toLowerCase())),
    [engines],
  )
  const otherRows = useMemo(
    () => engines.filter(row => !['running', 'starting', 'stale'].includes(String(row.status || '').toLowerCase())),
    [engines],
  )

  return (
    <div className="h-full overflow-auto p-5">
      {logTarget ? (
        <>
          <button
            type="button"
            aria-label="Close live log panel"
            className="fixed inset-0 z-30 bg-black/40"
            onClick={() => setLogTarget(null)}
          />
          <LiveLogPanel
            target={{
              id: logTarget.id,
              label: logTarget.strategyLabel,
              logFile: logTarget.logFile,
              isControlled: logTarget.isControlled,
            }}
            onClose={() => setLogTarget(null)}
          />
        </>
      ) : null}

      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-text-secondary">
            Live data-plane engines registered with the control plane. Heartbeats refresh every 10 seconds.
          </p>
          <p className="mt-1 text-[10px] text-text-secondary">
            Last updated {lastUpdatedAt ? formatRelativeTimestamp(lastUpdatedAt.toISOString()) : '—'}
            {' · '}
            stale threshold {STALE_HEARTBEAT_SECONDS}s
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setLoading(true)
            loadEngines()
          }}
          className="rounded border border-border bg-card px-3 py-1.5 text-[11px] font-semibold text-text-secondary hover:text-text-primary"
        >
          Refresh now
        </button>
      </div>

      {error ? (
        <div className="mb-4 rounded border border-red/40 bg-red/10 px-4 py-3 text-sm text-red">
          {error}
        </div>
      ) : null}

      <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-5">
        <StatCard label="Live servers" value={String(metrics.live)} hint={`${metrics.fresh} fresh heartbeat`} />
        <StatCard label="Running" value={String(metrics.running)} />
        <StatCard label="Starting" value={String(metrics.starting)} />
        <StatCard label="Stale" value={String(metrics.stale)} />
        <StatCard label="Total heartbeats" value={String(metrics.totalHeartbeats)} />
      </div>

      <EngineTable
        title="Active servers"
        subtitle="Running, starting, or stale engines with recent control-plane heartbeats"
        rows={liveRows}
        loading={loading}
        emptyMessage="No live servers are registered right now."
        onOpenLogs={setLogTarget}
      />

      {otherRows.length ? (
        <div className="mt-4">
          <EngineTable
            title="Other registered engines"
            subtitle="Pending, stopped, or inactive records kept in the registry"
            rows={otherRows}
            loading={false}
            emptyMessage="No other engines."
            onOpenLogs={setLogTarget}
          />
        </div>
      ) : null}
    </div>
  )
}

function EngineTable({
  title,
  subtitle,
  rows,
  loading,
  emptyMessage,
  onOpenLogs,
}: {
  title: string
  subtitle: string
  rows: EngineRow[]
  loading: boolean
  emptyMessage: string
  onOpenLogs: (row: EngineRow) => void
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3.5">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        <p className="mt-0.5 text-[11px] text-text-secondary">{subtitle}</p>
      </div>

      {loading && !rows.length ? (
        <div className="px-4 py-10 text-center text-sm text-text-secondary">Loading live servers…</div>
      ) : !rows.length ? (
        <div className="px-4 py-10 text-center text-sm text-text-secondary">{emptyMessage}</div>
      ) : (
        <div className="overflow-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="bg-black/15 text-left">
                <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">Status</th>
                <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">Execution / server</th>
                <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">Strategy</th>
                <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">Symbol</th>
                <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">Port</th>
                <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">Last heartbeat</th>
                <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">Heartbeats</th>
                <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">PID</th>
                <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">WS clients</th>
                <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">Live log</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const status = String(row.status || 'unknown')
                return (
                  <tr key={row.id} className="border-b border-border hover:bg-white/[0.02]">
                    <td className="px-3.5 py-2.5">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${statusTone(status)}`}>
                        {status}
                      </span>
                    </td>
                    <td className="px-3.5 py-2.5">
                      {row.isControlled ? (
                        <Link
                          to={`/trade/strategies/${encodeURIComponent(row.id)}`}
                          className="block max-w-[280px] font-mono text-[11px] text-accent hover:underline"
                          title={row.id}
                        >
                          {row.id}
                        </Link>
                      ) : (
                        <span className="block max-w-[280px] font-mono text-[11px] text-text-primary" title={row.id}>
                          {row.id}
                        </span>
                      )}
                      <div className="mt-0.5 text-[10px] text-text-secondary">
                        {row.broker || '—'} · {row.account_env || 'live'}
                      </div>
                    </td>
                    <td className="px-3.5 py-2.5">
                      {row.isControlled ? (
                        <Link
                          to={`/trade/strategies/${encodeURIComponent(row.id)}`}
                          className="font-semibold text-accent hover:underline"
                        >
                          {row.strategyLabel}
                        </Link>
                      ) : (
                        <span className="font-semibold">{row.strategyLabel}</span>
                      )}
                      <div className="mt-0.5 text-[10px] text-text-secondary">
                        {row.strategy_name || row.metadata?.strategy_name || '—'}
                      </div>
                    </td>
                    <td className="px-3.5 py-2.5 font-mono">{row.symbolLabel}</td>
                    <td className="px-3.5 py-2.5 font-mono">{row.port ? `:${row.port}` : '—'}</td>
                    <td className="px-3.5 py-2.5">
                      <div className={`font-mono font-semibold ${heartbeatTone(row)}`}>
                        {row.heartbeatAgeSec != null ? `${row.heartbeatAgeSec}s ago` : '—'}
                      </div>
                      <div className="mt-0.5 text-[10px] text-text-secondary">
                        {formatDbTimestamp(row.last_seen_at)}
                      </div>
                    </td>
                    <td className="px-3.5 py-2.5 font-mono">{row.heartbeat_count ?? 0}</td>
                    <td className="px-3.5 py-2.5 font-mono">{row.pid ?? row.last_heartbeat?.pid ?? '—'}</td>
                    <td className="px-3.5 py-2.5 font-mono">{row.wsClients ?? '—'}</td>
                    <td className="px-3.5 py-2.5">
                      <button
                        type="button"
                        onClick={() => onOpenLogs(row)}
                        className="inline-flex items-center gap-1.5 rounded border border-accent/40 bg-accent/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-accent hover:bg-accent/20"
                        title={row.logFile || 'Open execution log stream'}
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
                        Logs
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
