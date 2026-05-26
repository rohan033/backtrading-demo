import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import LiveLogPanel from '../../components/LiveLogPanel'
import {
  EmptyState,
  StrategyChartPanel,
  computeExecutionLevels,
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
import { formatScheduledStart, scheduleSummary } from '../../lib/tradingSchedule'

import './strategy-detail.css'

const CONTROL_API = '/api/control'

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

function formatRelativeTime(event) {
  const raw = event.created_at || event.received_at || event.timestamp
  if (!raw) return '—'
  const date = typeof raw === 'number' ? new Date(raw * 1000) : new Date(raw)
  if (Number.isNaN(date.getTime())) return '—'
  const deltaMs = Date.now() - date.getTime()
  const minutes = Math.floor(deltaMs / 60000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  return date.toLocaleDateString()
}

function getEventAction(event) {
  return String(event.action || event.activity_type || event.event_type || event.type || 'EVENT').toUpperCase()
}

function mapEventToActivity(event) {
  const action = getEventAction(event)
  const details = event.details || event.content || {}
  const symbol = String(event.symbol || details.symbol || '').trim()

  let type = 'info'
  if (action.includes('BUY') || (action.includes('FILLED') && !action.includes('SELL'))) type = 'buy'
  else if (action.includes('SELL') || action.includes('CLOSE') || action.includes('TAKE_PROFIT') || action.includes('STOP_LOSS')) type = 'sell'
  else if (action.includes('PENDING')) type = 'pending'

  const titleParts = [action.replace(/_/g, ' ').toLowerCase()]
  if (symbol) titleParts.push(`· ${symbol}`)

  const detailParts = [
    details.quantity && details.price ? `${details.quantity} units @ ${details.price}` : '',
    event.order_id ? `order ${event.order_id}` : '',
    details.message ? String(details.message) : '',
    details.reason ? String(details.reason) : '',
  ].filter(Boolean)

  return { type, title: titleParts.join(' '), detail: detailParts.join(' · ') || 'Strategy event', time: formatRelativeTime(event) }
}

function ActivityFeed({ executorId, realtimeEvents }) {
  const [dbEvents, setDbEvents] = useState([])

  useEffect(() => {
    const params = new URLSearchParams({ limit: '20', executor_id: executorId })
    fetch(`${CONTROL_API}/events?${params}`)
      .then(res => res.json())
      .then(data => { if (data.status) setDbEvents(data.data || []) })
      .catch(() => setDbEvents([]))
  }, [executorId, realtimeEvents.length])

  const events = useMemo(() => {
    const seen = new Set()
    return [...realtimeEvents, ...dbEvents]
      .filter(event => {
        const execId = event.executor_id || event.details?.executor_id
        if (execId && execId !== executorId) return false
        const key = `${event.id || ''}-${event.timestamp || event.created_at || ''}-${event.action}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, 6)
      .map(mapEventToActivity)
  }, [realtimeEvents, dbEvents, executorId])

  return (
    <div className="sd-card flex h-full min-h-[360px] flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--sd-border)] px-4 py-3.5">
        <h3 className="text-[13px] font-semibold">Activity</h3>
        <Link to="/trade/activity" className="text-xs font-semibold text-[var(--sd-accent)] hover:underline">
          View all
        </Link>
      </div>
      <div className="flex-1 overflow-auto px-4 py-1">
        {events.length ? events.map((item, index) => {
          const iconStyle = item.type === 'buy'
            ? { background: 'var(--sd-green-soft)', color: 'var(--sd-green)' }
            : item.type === 'sell'
              ? { background: 'var(--sd-red-soft)', color: 'var(--sd-red)' }
              : item.type === 'pending'
                ? { background: 'rgba(251, 191, 36, 0.15)', color: '#fbbf24' }
                : { background: 'var(--sd-accent-soft)', color: 'var(--sd-accent)' }
          const icon = item.type === 'buy' ? '▲' : item.type === 'sell' ? '▼' : item.type === 'pending' ? '◷' : '●'

          return (
            <div key={`${item.title}-${index}`} className="flex gap-3 border-b border-[var(--sd-border)] py-3 last:border-b-0">
              <div
                className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs"
                style={iconStyle}
              >
                {icon}
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold capitalize">{item.title}</div>
                {item.detail ? <div className="text-xs text-[var(--sd-text-muted)]">{item.detail}</div> : null}
                <div className="mt-0.5 text-[11px] text-[var(--sd-text-muted)]">{item.time}</div>
              </div>
            </div>
          )
        }) : (
          <div className="py-10 text-center text-sm text-[var(--sd-text-muted)]">No activity for this strategy yet.</div>
        )}
      </div>
    </div>
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
  const levels = useMemo(() => computeExecutionLevels(execution || {}), [execution])
  const broker = execution?.broker
  const port = execution?.data_plane_port || queuedItem?.engine?.port
  const pnl = 0
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
        <div className="mb-4 grid grid-cols-2 gap-2.5 xl:grid-cols-5">
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
          <ActivityFeed executorId={executionId} realtimeEvents={strategyActivityEvents} />
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
                ['Entry threshold', execution?.initial_threshold != null ? `${execution.initial_threshold}%` : '—'],
                ['Take profit %', execution?.long_percent != null ? `${execution.long_percent}%` : '—'],
                ['Stop loss %', execution?.short_percent != null ? `${execution.short_percent}%` : '—'],
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
