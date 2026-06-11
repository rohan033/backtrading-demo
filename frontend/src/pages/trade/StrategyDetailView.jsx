import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import LiveLogPanel from '../../components/LiveLogPanel'
import {
  EmptyState,
  StrategyChartPanel,
  computeExecutionLevels,
  formatOrderQuantity,
} from '../../ExecutionWorkspace'
import {
  formatBrokerCompactMoney,
  formatBrokerPrice,
  formatBrokerSignedMoney,
} from '../../lib/currency'
import { formatDbTimestamp } from '../../lib/datetime'
import {
  executionSourceHref,
  executionSourceLabel,
  resolveExecutionSourceId,
  resolveExecutionSourceMetaId,
} from '../../lib/executionSources'
import { TradingActivityFeed } from '../../components/TradingActivityFeed'
import { formatScheduledStart, scheduleSummary } from '../../lib/tradingSchedule'

import './strategy-detail.css'

function strategyTitle(execution) {
  if (!execution) return 'Strategy'
  const symbol = execution.symbol || '—'
  const pct = execution.long_percent != null ? `${execution.long_percent}%` : ''
  const template = execution.strategy_name === 'one-percent'
    ? 'Breakout'
    : (execution.strategy_name || 'Strategy')
  return [symbol, pct, template].filter(Boolean).join(' ')
}

function envLabel(env) {
  return String(env || 'live').toLowerCase() === 'demo' ? 'Demo' : 'Live'
}

function statusBadgeTone(isLive, engineStatus) {
  if (isLive && ['running', 'starting', 'stale'].includes(engineStatus)) return 'running'
  if (engineStatus === 'scheduled') return 'scheduled'
  return 'draft'
}

function statusBadgeLabel(isLive, engineStatus) {
  if (isLive && ['running', 'starting', 'stale'].includes(engineStatus)) {
    if (engineStatus === 'starting') return 'Starting'
    if (engineStatus === 'stale') return 'Stale'
    return 'Running'
  }
  if (engineStatus === 'scheduled') return 'Scheduled'
  return 'Draft'
}

function StatusBadge({ tone, children }) {
  const toneClass = tone === 'running'
    ? 'sd-badge-running'
    : tone === 'scheduled'
      ? 'sd-badge-scheduled'
    : tone === 'demo'
      ? 'sd-badge-demo'
      : tone === 'live'
        ? 'sd-badge-live'
        : tone === 'position'
          ? 'sd-badge-position'
          : 'sd-badge-draft'

  return <span className={`sd-badge ${toneClass}`}>{children}</span>
}

function DetailChip({ children }) {
  return <span className="sd-chip">{children}</span>
}

function MetricTile({ label, value, valueClass = '' }) {
  return (
    <div className="sd-stat">
      <div className="label">{label}</div>
      <div className={`value ${valueClass}`}>{value}</div>
    </div>
  )
}

function ConfigAccordion({ title, subtitle, children, defaultOpen = false }) {
  return (
    <details className="sd-card sd-accordion overflow-hidden" open={defaultOpen ? true : undefined}>
      <summary className="flex items-center justify-between gap-3 border-b border-[var(--sd-border)] px-4 py-3.5">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        <span className="text-[11px] text-[var(--sd-text-muted)]">{subtitle}</span>
      </summary>
      <div className="px-4 py-3.5">{children}</div>
    </details>
  )
}

function RuntimePills({ port, apiBaseUrl, wsUrl, logFile, pending }) {
  const pills = [
    { label: 'Port', value: port ? `:${port}` : null, accent: true },
    { label: 'API', value: apiBaseUrl },
    { label: 'WebSocket', value: wsUrl },
    { label: 'Log', value: logFile },
  ]

  return (
    <div className="flex flex-wrap gap-2">
      {pills.map(({ label, value, accent }) => (
        <div
          key={label}
          className={`sd-runtime-pill${accent ? ' accent' : ''}`}
          title={value || undefined}
        >
          <span className="label">{label}</span>
          <span className="value">{value || (pending ? 'After deploy' : '—')}</span>
        </div>
      ))}
    </div>
  )
}

const LIVE_PNL_POLL_MS = 10_000

function PositionsPanel({ executorId, execution }) {
  const [positions, setPositions] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [unitInputs, setUnitInputs] = useState({})
  const [closing, setClosing] = useState({})
  const [closeErrors, setCloseErrors] = useState({})
  const [closedIds, setClosedIds] = useState(new Set())
  const [livePnl, setLivePnl] = useState({})   // position_id → { pnl, pnl_pct, current_rate }
  const [totalPnl, setTotalPnl] = useState(null)

  const broker = execution?.broker
  const accountEnv = execution?.account_env || 'demo'

  const fetchPositions = useCallback(async () => {
    if (!executorId) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/control/executions/${encodeURIComponent(executorId)}/positions`)
      const data = await res.json()
      if (data.status) setPositions(data.data || [])
      else setError(data.message || 'Failed to load positions')
    } catch (e) {
      setError('Network error loading positions')
    } finally {
      setLoading(false)
    }
  }, [executorId])

  const fetchLivePnl = useCallback(async () => {
    if (!executorId || broker !== 'etoro') return
    try {
      const res = await fetch(`/api/control/executions/${encodeURIComponent(executorId)}/live-pnl`)
      const data = await res.json()
      if (data.status) {
        const map = {}
        for (const item of data.data || []) map[item.position_id] = item
        setLivePnl(map)
        setTotalPnl(data.total_pnl ?? null)
      }
    } catch { /* silent — P&L is best-effort */ }
  }, [executorId, broker])

  useEffect(() => { fetchPositions() }, [fetchPositions])

  useEffect(() => {
    fetchLivePnl()
    const id = setInterval(fetchLivePnl, LIVE_PNL_POLL_MS)
    return () => clearInterval(id)
  }, [fetchLivePnl])

  const handleClose = useCallback(async (positionId, maxUnits) => {
    const raw = unitInputs[positionId]
    const units = raw !== '' && raw != null ? parseFloat(raw) : null

    if (units !== null && (isNaN(units) || units <= 0 || units > maxUnits)) {
      setCloseErrors(prev => ({ ...prev, [positionId]: `Units must be between 0 and ${maxUnits}` }))
      return
    }

    setClosing(prev => ({ ...prev, [positionId]: true }))
    setCloseErrors(prev => ({ ...prev, [positionId]: null }))

    try {
      const res = await fetch(
        `/api/control/executions/${encodeURIComponent(executorId)}/positions/${encodeURIComponent(positionId)}/close`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ units: units || null }),
        },
      )
      const data = await res.json()
      if (res.ok && data.status) {
        setClosedIds(prev => new Set([...prev, positionId]))
        fetchPositions()
      } else {
        setCloseErrors(prev => ({
          ...prev,
          [positionId]: data.detail || data.message || 'Close failed',
        }))
      }
    } catch (e) {
      setCloseErrors(prev => ({ ...prev, [positionId]: 'Network error' }))
    } finally {
      setClosing(prev => ({ ...prev, [positionId]: false }))
    }
  }, [executorId, unitInputs, fetchPositions])

  if (!executorId) return (
    <div className="py-8 text-center text-sm" style={{ color: 'var(--sd-text-muted)' }}>
      No execution selected.
    </div>
  )

  if (loading && !positions.length) return (
    <div className="py-8 text-center text-sm" style={{ color: 'var(--sd-text-muted)' }}>
      Loading positions…
    </div>
  )

  if (error) return (
    <div className="py-4 text-center text-sm" style={{ color: 'var(--sd-red)' }}>
      {error}
      <button type="button" className="ml-2 underline" onClick={fetchPositions}>Retry</button>
    </div>
  )

  const open = positions.filter(p => (p.state || p.position?.state) !== 'closed' && !closedIds.has(p.position_id))
  const closed = positions.filter(p => (p.state || p.position?.state) === 'closed' || closedIds.has(p.position_id))

  if (!positions.length) return (
    <div className="py-8 text-center text-sm" style={{ color: 'var(--sd-text-muted)' }}>
      No positions tracked for this execution yet.
    </div>
  )

  const formatPrice = (v) => v != null ? `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}` : '—'
  const formatPnl = (v) => {
    if (v == null) return null
    const n = Number(v)
    const sign = n >= 0 ? '+' : ''
    return `${sign}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  const renderRow = (p) => {
    const pos = p.position || {}
    const posId = p.position_id
    const state = p.state || pos.state || '?'
    const isOpen = state !== 'closed' && !closedIds.has(posId)
    const remaining = p.remaining_units ?? pos.remainingUnits ?? null
    const opening = pos.openingData || {}
    const avgPrice = opening.avgPrice ?? pos.openRate ?? null
    const sl = pos.stopLossRate ?? null
    const tp = pos.takeProfitRate ?? null
    const isBusy = closing[posId]
    const live = livePnl[posId] ?? null

    return (
      <div
        key={posId}
        className="rounded-lg border p-3"
        style={{
          borderColor: isOpen ? 'var(--sd-border)' : 'rgba(139,156,176,0.25)',
          background: isOpen ? 'var(--sd-bg-elevated)' : 'transparent',
          opacity: isOpen ? 1 : 0.55,
        }}
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="font-mono text-[11px]" style={{ color: 'var(--sd-text-muted)' }}>
            #{posId}
          </span>
          <div className="flex items-center gap-2">
            {isOpen && live != null && (
              <span
                className="font-mono text-[13px] font-bold"
                style={{ color: live.pnl >= 0 ? 'var(--sd-green)' : 'var(--sd-red)' }}
              >
                {formatPnl(live.pnl)}
                <span className="ml-1 text-[10px] font-normal opacity-70">
                  ({live.pnl >= 0 ? '+' : ''}{live.pnl_pct?.toFixed(2)}%)
                </span>
              </span>
            )}
            <span
              className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest"
              style={
                isOpen
                  ? { background: 'var(--sd-green-soft)', color: 'var(--sd-green)' }
                  : { background: 'rgba(139,156,176,0.15)', color: 'var(--sd-text-muted)' }
              }
            >
              {isOpen ? 'Open' : 'Closed'}
            </span>
          </div>
        </div>

        <div className="mb-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] sm:grid-cols-4">
          <div>
            <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--sd-text-muted)' }}>Units</div>
            <div className="font-mono font-semibold">{remaining != null ? Number(remaining).toFixed(6) : '—'}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--sd-text-muted)' }}>Avg price</div>
            <div className="font-mono font-semibold">{formatPrice(avgPrice)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--sd-text-muted)' }}>
              {live ? 'Current price' : 'Stop loss'}
            </div>
            <div className="font-mono" style={{ color: live ? 'var(--sd-text)' : 'var(--sd-red)' }}>
              {live ? formatPrice(live.current_rate) : formatPrice(sl)}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--sd-text-muted)' }}>
              {live ? 'Stop loss' : 'Take profit'}
            </div>
            <div className="font-mono" style={{ color: live ? 'var(--sd-red)' : 'var(--sd-green)' }}>
              {live ? formatPrice(sl) : formatPrice(tp)}
            </div>
          </div>
        </div>

        {live && isOpen && (
          <div className="mb-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] sm:grid-cols-4">
            <div />
            <div />
            <div>
              <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--sd-text-muted)' }}>Take profit</div>
              <div className="font-mono" style={{ color: 'var(--sd-green)' }}>{formatPrice(tp)}</div>
            </div>
            <div />
          </div>
        )}

        {isOpen && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              type="number"
              min="0.000001"
              max={remaining ?? undefined}
              step="0.001"
              placeholder={`Units (max ${remaining != null ? Number(remaining).toFixed(4) : '?'})`}
              value={unitInputs[posId] ?? ''}
              onChange={e => setUnitInputs(prev => ({ ...prev, [posId]: e.target.value }))}
              className="h-8 w-44 rounded-md border bg-transparent px-2 text-[12px] font-mono outline-none focus:border-[var(--sd-accent)]"
              style={{ borderColor: 'var(--sd-border)', color: 'var(--sd-text)' }}
              disabled={isBusy}
            />
            <button
              type="button"
              className="sd-btn h-8 px-3 text-[12px]"
              style={isBusy ? {} : { borderColor: 'var(--sd-red)', color: 'var(--sd-red)' }}
              disabled={isBusy}
              onClick={() => handleClose(posId, remaining ?? Infinity)}
            >
              {isBusy ? 'Closing…' : 'Close position'}
            </button>
            {closeErrors[posId] && (
              <span className="text-[11px]" style={{ color: 'var(--sd-red)' }}>{closeErrors[posId]}</span>
            )}
          </div>
        )}
      </div>
    )
  }

  const hasOpenWithLive = open.length > 0 && totalPnl != null

  return (
    <div className="space-y-2">
      {/* Total P&L banner across all open positions */}
      {hasOpenWithLive && (
        <div
          className="flex items-center justify-between rounded-lg px-3 py-2 text-[12px]"
          style={{
            background: totalPnl >= 0 ? 'rgba(0,200,83,0.08)' : 'rgba(255,23,68,0.08)',
            border: `1px solid ${totalPnl >= 0 ? 'rgba(0,200,83,0.25)' : 'rgba(255,23,68,0.25)'}`,
          }}
        >
          <span style={{ color: 'var(--sd-text-muted)' }}>
            P&amp;L across {open.length} open position{open.length !== 1 ? 's' : ''}
          </span>
          <span
            className="font-mono text-[16px] font-bold"
            style={{ color: totalPnl >= 0 ? 'var(--sd-green)' : 'var(--sd-red)' }}
          >
            {formatPnl(totalPnl)}
          </span>
        </div>
      )}

      {open.length > 0 && (
        <div className="space-y-2">
          {open.map(renderRow)}
        </div>
      )}
      {closed.length > 0 && (
        <details className="mt-1">
          <summary
            className="cursor-pointer text-[11px] uppercase tracking-wider"
            style={{ color: 'var(--sd-text-muted)' }}
          >
            {closed.length} closed position{closed.length !== 1 ? 's' : ''}
          </summary>
          <div className="mt-2 space-y-2">{closed.map(renderRow)}</div>
        </details>
      )}
    </div>
  )
}

const PANEL_TABS = ['Activity', 'Positions']

function ActivityAndPositionsPanel({ executorId, execution, realtimeEvents }) {
  const [tab, setTab] = useState('Activity')
  return (
    <div
      className="sd-card flex h-full min-h-[360px] flex-col overflow-hidden"
      style={{ borderColor: 'var(--sd-border)', background: 'var(--sd-bg-card)' }}
    >
      <div className="flex items-center gap-0 border-b" style={{ borderColor: 'var(--sd-border)' }}>
        {PANEL_TABS.map(t => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className="px-4 py-3 text-[13px] font-semibold transition-colors"
            style={
              tab === t
                ? { color: 'var(--sd-accent)', borderBottom: '2px solid var(--sd-accent)', marginBottom: -1 }
                : { color: 'var(--sd-text-muted)', borderBottom: '2px solid transparent', marginBottom: -1 }
            }
          >
            {t}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto px-4 py-3">
        {tab === 'Activity' ? (
          <TradingActivityFeed
            executorId={executorId}
            realtimeEvents={realtimeEvents}
            viewAllHref="/trade/activity"
            className="!border-0 !bg-transparent !rounded-none !shadow-none -mx-4 -my-3"
          />
        ) : (
          <PositionsPanel executorId={executorId} execution={execution} />
        )}
      </div>
    </div>
  )
}

function ActivityFeed({ executorId, execution, realtimeEvents }) {
  return (
    <ActivityAndPositionsPanel
      executorId={executorId}
      execution={execution}
      realtimeEvents={realtimeEvents}
    />
  )
}

export default function StrategyDetailView({
  executionId,
  execution,
  queuedItem,
  engineStatus,
  isLive,
  planeStreams,
  selectedTick,
  liveApi,
  strategyActivityEvents,
  refreshExecutions,
  onStop,
  stopping,
  onDeploy,
  deploying,
  onUnschedule,
  unscheduling,
  onDuplicate,
  actionError,
}) {
  const [logOpen, setLogOpen] = useState(false)
  const [filledQty, setFilledQty] = useState(null)
  const levels = useMemo(() => computeExecutionLevels(execution || {}), [execution])
  const broker = execution?.broker
  const port = execution?.data_plane_port || queuedItem?.engine?.port
  const pnl = 0
  const qtyDecimals = execution?.allow_partial_stocks ? 2 : 0
  const displayQty = filledQty ?? levels.orderQuantity
  const qtyLabel = filledQty != null || execution?.is_in_position ? 'Qty bought' : 'Order qty'

  useEffect(() => {
    if (!executionId) return
    let cancelled = false

    ;(async () => {
      try {
        const res = await fetch(`/api/control/executions/${encodeURIComponent(executionId)}/positions`)
        const data = await res.json()
        if (cancelled || !data.status) return

        const totalUnits = (data.data || []).reduce((sum, row) => {
          const position = row.position || {}
          const units = Number(
            row.remaining_units
            ?? position.remainingUnits
            ?? position.units
            ?? position.Units
            ?? 0,
          )
          return Number.isFinite(units) && units > 0 ? sum + units : sum
        }, 0)

        setFilledQty(totalUnits > 0 ? totalUnits : null)
      } catch {
        if (!cancelled) setFilledQty(null)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [executionId, execution?.is_in_position, strategyActivityEvents?.length])
  const runtimePending = !execution?.log_file && !execution?.data_plane_port && !port
  const env = String(execution?.account_env || 'live').toLowerCase()
  const badgeTone = statusBadgeTone(isLive, engineStatus)
  const sourceId = resolveExecutionSourceId(execution, queuedItem)
  const sourceMetaId = resolveExecutionSourceMetaId(execution, queuedItem)
  const sourceLabel = executionSourceLabel(sourceId)
  const sourceHref = executionSourceHref(sourceId, sourceMetaId)

  if (!execution && !queuedItem) {
    return (
      <EmptyState
        title="Strategy not found"
        body="This execution is not in the control plane registry."
        action={<Link to="/trade/strategies" className="text-accent hover:underline">← Back to strategies</Link>}
      />
    )
  }

  const canStop = isLive && ['running', 'starting', 'stale'].includes(engineStatus)
  const canDeploy = !isLive
  const isScheduled = engineStatus === 'scheduled'
  const scheduledStartAt = execution?.scheduled_start_at
    || queuedItem?.engine?.metadata?.scheduled_start_at
    || null
  const scheduleLabel = execution?.market_open_label
    || queuedItem?.engine?.metadata?.market_open_label
    || null
  const tradingDay = execution?.trading_day
    || queuedItem?.engine?.metadata?.trading_day
    || null
  const logFile = execution?.log_file || queuedItem?.engine?.metadata?.log_file || null
  const logEngineId = execution?.data_plane_id || queuedItem?.engine?.id || executionId

  return (
    <div className="strategy-detail flex h-full flex-col overflow-hidden">
      {logOpen ? (
        <>
          <button
            type="button"
            aria-label="Close live log panel"
            className="fixed inset-0 z-30 bg-black/40"
            onClick={() => setLogOpen(false)}
          />
          <LiveLogPanel
            target={{
              id: logEngineId,
              label: strategyTitle(execution),
              logFile,
              isControlled: true,
            }}
            onClose={() => setLogOpen(false)}
          />
        </>
      ) : null}

      <div className="shrink-0 border-b border-[var(--sd-border)] px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[20px] font-bold tracking-tight">{strategyTitle(execution)}</h1>
            <p className="mt-1 font-mono text-[11px] text-[var(--sd-accent)]">{executionId}</p>
            {execution?.created_at ? (
              <p className="mt-1 text-[11px] text-[var(--sd-text-muted)]">
                Created {formatDbTimestamp(execution.created_at)} · Source {sourceLabel}
                {sourceHref ? (
                  <>
                    {' · '}
                    <Link to={sourceHref} className="font-semibold text-[var(--sd-accent)] hover:underline">
                      Go to source
                    </Link>
                  </>
                ) : null}
              </p>
            ) : (
              <p className="mt-1 text-[11px] text-[var(--sd-text-muted)]">
                Source {sourceLabel}
                {sourceHref ? (
                  <>
                    {' · '}
                    <Link to={sourceHref} className="font-semibold text-[var(--sd-accent)] hover:underline">
                      Go to source
                    </Link>
                  </>
                ) : null}
              </p>
            )}
            {isScheduled && (scheduledStartAt || tradingDay) ? (
              <div className="sd-schedule-banner mt-3 max-w-xl">
                <div className="title">Scheduled deployment</div>
                <div className="detail">
                  {formatScheduledStart(scheduledStartAt)} · {scheduleSummary(tradingDay, scheduleLabel)}
                </div>
                <p className="mt-1 text-[11px] text-[var(--sd-text-muted)]">
                  Auto-starts at market open, or use Deploy now to start immediately.
                </p>
              </div>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusBadge tone={env === 'demo' ? 'demo' : 'live'}>{envLabel(execution?.account_env)}</StatusBadge>
              <StatusBadge tone={badgeTone}>{statusBadgeLabel(isLive, engineStatus)}</StatusBadge>
              <DetailChip>Source · {sourceLabel}</DetailChip>
              {sourceHref ? (
                <Link to={sourceHref} className="sd-chip text-[var(--sd-accent)] hover:underline">
                  Go to source
                </Link>
              ) : null}
              {execution?.is_in_position ? <StatusBadge tone="position">In position</StatusBadge> : null}
              {execution?.symbol ? <DetailChip>{execution.symbol}</DetailChip> : null}
              {port ? <DetailChip>Runtime :{port}</DetailChip> : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link to="/trade/strategies" className="sd-btn">
              ← Back
            </Link>
            {canDeploy ? (
              <button
                type="button"
                onClick={onDeploy}
                disabled={deploying || stopping || unscheduling}
                className="sd-btn sd-btn-primary"
              >
                {deploying ? 'Deploying…' : isScheduled ? 'Deploy now' : 'Deploy live'}
              </button>
            ) : null}
            {isScheduled && onUnschedule ? (
              <button
                type="button"
                onClick={onUnschedule}
                disabled={unscheduling || deploying || stopping}
                className="sd-btn"
              >
                {unscheduling ? 'Unscheduling…' : 'Unschedule'}
              </button>
            ) : null}
            {canStop ? (
              <button
                type="button"
                onClick={onStop}
                disabled={stopping || deploying || unscheduling}
                className="sd-btn sd-btn-danger"
              >
                {stopping ? 'Stopping…' : 'Stop'}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setLogOpen(true)}
              className="sd-btn inline-flex items-center gap-1.5 border-accent/40 bg-accent/10 text-accent hover:bg-accent/20"
              title={logFile || 'Open execution log stream'}
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
              Logs
            </button>
            <button
              type="button"
              onClick={onDuplicate}
              disabled={deploying || stopping}
              className="sd-btn"
            >
              Duplicate
            </button>
          </div>
        </div>
        {actionError ? (
          <p className="mt-3 text-xs text-[var(--sd-red)]">{actionError}</p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-5">
        <div className="mb-4 grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-7">
          <MetricTile
            label="Entry trigger"
            value={levels.buyTrigger != null ? formatBrokerPrice(broker, levels.buyTrigger) : '—'}
          />
          <MetricTile
            label="Take profit"
            value={levels.takeProfit != null ? formatBrokerPrice(broker, levels.takeProfit) : '—'}
            valueClass="text-[var(--sd-green)]"
          />
          <MetricTile
            label="Stop loss"
            value={levels.stopLoss != null ? formatBrokerPrice(broker, levels.stopLoss) : '—'}
            valueClass="text-[var(--sd-red)]"
          />
          <MetricTile
            label="Capital"
            value={execution?.max_available_capital != null
              ? formatBrokerCompactMoney(broker, execution.max_available_capital)
              : '—'}
          />
          <MetricTile
            label={qtyLabel}
            value={displayQty != null
              ? (filledQty != null
                ? displayQty.toFixed(qtyDecimals)
                : formatOrderQuantity(execution, displayQty))
              : '—'}
          />
          <MetricTile
            label="Potential profit"
            value={levels.potentialProfitAbsolute != null
              ? formatBrokerCompactMoney(broker, levels.potentialProfitAbsolute)
              : '—'}
            valueClass="text-[var(--sd-green)]"
          />
          <MetricTile
            label="P&L"
            value={formatBrokerSignedMoney(broker, pnl)}
            valueClass={pnl >= 0 ? 'text-[var(--sd-green)]' : 'text-[var(--sd-red)]'}
          />
        </div>

        <div className="mb-4 grid gap-4 xl:grid-cols-[1.4fr_0.9fr]">
          <StrategyChartPanel
            execution={execution}
            planeStreams={planeStreams}
            selectedTick={selectedTick}
          />
          <ActivityFeed executorId={executionId} execution={execution} realtimeEvents={strategyActivityEvents} />
        </div>

        <div className="space-y-3">
          <ConfigAccordion title="Runtime configuration" subtitle="Collapsed by default">
            <RuntimePills
              port={execution?.data_plane_port || queuedItem?.engine?.port}
              apiBaseUrl={execution?.api_base_url || liveApi || queuedItem?.engine?.api_base_url}
              wsUrl={execution?.ws_url || queuedItem?.engine?.ws_url}
              logFile={execution?.log_file || queuedItem?.engine?.metadata?.log_file}
              pending={runtimePending}
            />
          </ConfigAccordion>

          <ConfigAccordion title="Advanced configuration" subtitle="Collapsed by default">
            <dl className="grid grid-cols-1 gap-x-8 gap-y-2 font-mono text-[11px] leading-relaxed text-[var(--sd-text-muted)] md:grid-cols-2">
              {[
                ['Execution ID', executionId],
                ['Source', sourceLabel],
                ...(sourceHref
                  ? [[
                      'Research session',
                      <Link key="research-source" to={sourceHref} className="text-[var(--sd-accent)] hover:underline">
                        Go to source
                      </Link>,
                    ]]
                  : []),
                ['Strategy template', execution?.strategy_name || '—'],
                ['Broker', execution?.broker || '—'],
                ['Instrument ID', execution?.token || '—'],
                ['Close price', levels.closePrice != null ? formatBrokerPrice(broker, levels.closePrice) : '—'],
                ['Order qty', displayQty != null
                  ? (filledQty != null
                    ? displayQty.toFixed(qtyDecimals)
                    : formatOrderQuantity(execution, displayQty))
                  : '—'],
                ['Potential profit', levels.potentialProfitAbsolute != null
                  ? formatBrokerCompactMoney(broker, levels.potentialProfitAbsolute)
                  : '—'],
                ['Entry threshold', execution?.initial_threshold != null ? `${execution.initial_threshold}%` : '—'],
                ['Take profit %', execution?.long_percent != null ? `${execution.long_percent}%` : '—'],
                ['Stop loss', levels.stopLossUsesAmount
                  ? `${formatBrokerCompactMoney(broker, levels.stopLossAmount)} max loss`
                  : execution?.short_percent != null ? `${execution.short_percent}%` : '—'],
                ['Client mode', execution?.is_bracket_order_client ? 'Bracket orders' : 'Feed TP/SL'],
                ['Partial stocks', execution?.allow_partial_stocks ? 'Yes (2 dp)' : 'No (whole shares)'],
                ['Tick sampling', execution?.tick_sample_every != null ? `Every ${execution.tick_sample_every} tick(s)` : 'Every tick'],
                ['Scheduled start', isScheduled
                  ? formatScheduledStart(scheduledStartAt)
                  : '—'],
                ['Trading day', isScheduled ? scheduleSummary(tradingDay, scheduleLabel) : '—'],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-4 border-b border-[var(--sd-border)]/40 pb-1.5">
                  <dt>{label}</dt>
                  <dd className="max-w-[60%] text-right text-[var(--sd-text)]">
                    {typeof value === 'string' || typeof value === 'number' ? String(value) : value}
                  </dd>
                </div>
              ))}
            </dl>
            <button
              type="button"
              onClick={refreshExecutions}
              className="mt-3 text-[10px] font-semibold text-[var(--sd-accent)] hover:underline"
            >
              Refresh execution state
            </button>
          </ConfigAccordion>
        </div>
      </div>
    </div>
  )
}
