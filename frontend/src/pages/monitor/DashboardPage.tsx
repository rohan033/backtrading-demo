import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Zap } from 'lucide-react'

import { Button } from '../../components/ui/button'
import { StrategiesTable } from '../../components/StrategiesTable'

type RunningStrategy = {
  id: string
  name: string
  symbol: string
  status: string
  createdAt?: string | null
  startedAt?: string | null
  inPosition: boolean
  pnl: number
}

type StrategyMetrics = {
  total: number
  running: number
  stopped: number
  pending: number
}

type ExecutionRecord = {
  status: string
  startedAt?: string | null
}

function computeStrategyMetrics(records: ExecutionRecord[]): StrategyMetrics {
  const metrics = { total: records.length, running: 0, stopped: 0, pending: 0 }

  for (const record of records) {
    const status = String(record.status || 'unknown').toLowerCase()
    if (['running', 'starting'].includes(status)) {
      metrics.running += 1
      continue
    }
    if (status === 'pending' && !record.startedAt) {
      metrics.pending += 1
      continue
    }
    if (['stopped', 'stale', 'failed'].includes(status) || record.startedAt) {
      metrics.stopped += 1
      continue
    }
    metrics.pending += 1
  }

  return metrics
}

type ActivityItem = {
  type: 'buy' | 'sell' | 'info'
  title: string
  detail: string
  time: string
}

type ControlEvent = {
  action?: string
  activity_type?: string
  event_type?: string
  type?: string
  symbol?: string
  created_at?: string
  received_at?: string
  timestamp?: number
  details?: Record<string, unknown>
  content?: Record<string, unknown>
  order_id?: string
  executor_id?: string
}

function StatCard({ label, value, valueClass = '' }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3.5">
      <div className="mb-1.5 text-[10px] uppercase tracking-widest text-text-secondary">{label}</div>
      <div className={`font-mono text-xl font-bold ${valueClass}`}>{value}</div>
    </div>
  )
}

const STRATEGY_STEPS = [
  'Choose a symbol and broker',
  'Set entry, take-profit, and stop-loss',
  'Deploy to start live streaming',
]

function RunningStrategiesEmpty() {
  return (
    <div className="grid min-h-[240px] gap-6 px-5 py-7 md:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
      <div className="relative flex items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-gradient-to-br from-accent/5 via-transparent to-transparent px-4 py-6">
        <div className="strategy-empty-float relative flex w-full max-w-[240px] flex-col items-center">
          <div className="relative grid h-28 w-28 place-items-center">
            <span className="strategy-empty-pulse absolute inset-0 rounded-full border border-accent/25" />
            <span
              className="strategy-empty-pulse absolute inset-3 rounded-full border border-accent/35"
              style={{ animationDelay: '0.5s' }}
            />
            <span className="relative grid h-14 w-14 place-items-center rounded-full bg-accent/15 text-accent">
              <Zap className="h-7 w-7" aria-hidden="true" />
            </span>
          </div>

          <svg className="mt-5 h-8 w-full max-w-[180px] text-accent/50" viewBox="0 0 180 32" aria-hidden="true">
            <line x1="16" y1="16" x2="164" y2="16" className="strategy-empty-dash" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="16" cy="16" r="4" fill="currentColor" opacity="0.8" />
            <circle cx="90" cy="16" r="4" fill="currentColor" opacity="0.45" />
            <circle cx="164" cy="16" r="4" fill="currentColor" opacity="0.25" />
          </svg>

          <div className="mt-4 w-full space-y-2">
            {['Breakout · TSLA', 'Scalper · AAPL', 'Momentum · NVDA'].map((label, index) => (
              <div
                key={label}
                className="flex items-center gap-2 rounded border border-border/50 bg-secondary/40 px-3 py-2 opacity-70"
                style={{ animationDelay: `${index * 120}ms` }}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-accent/70" />
                <span className="flex-1 truncate text-[10px] text-text-secondary">{label}</span>
                <span className="text-[9px] uppercase tracking-wide text-text-secondary/70">Draft</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-col justify-center py-2">
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-accent">Trade · Strategies</p>
        <h4 className="mt-2 text-base font-semibold text-text-primary">No strategies running yet</h4>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-text-secondary">
          Deploy a strategy to stream live prices, track orders, and monitor P&amp;L from this panel.
        </p>

        <ul className="mt-4 space-y-2">
          {STRATEGY_STEPS.map((step, index) => (
            <li key={step} className="flex items-start gap-2 text-[11px] text-text-secondary">
              <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-accent/15 text-[9px] font-bold text-accent">
                {index + 1}
              </span>
              {step}
            </li>
          ))}
        </ul>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button asChild className="strategy-cta-glow group bg-accent text-white hover:bg-accent/90">
            <Link to="/trade/strategies/new" className="inline-flex items-center">
              Create strategy
              <ArrowRight className="ml-1.5 h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </Button>
          <Button asChild variant="tertiary" size="sm">
            <Link to="/trade/strategies">View all strategies</Link>
          </Button>
        </div>
      </div>
    </div>
  )
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const iconClass =
    item.type === 'buy'
      ? 'bg-green/15 text-green'
      : item.type === 'sell'
        ? 'bg-red/15 text-red'
        : 'bg-accent/15 text-accent'
  const icon = item.type === 'buy' ? '▲' : item.type === 'sell' ? '▼' : '●'

  return (
    <div className="flex gap-3 border-b border-border py-3 last:border-b-0">
      <div className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs ${iconClass}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xs font-semibold">{item.title}</div>
        <div className="text-xs text-text-secondary">{item.detail}</div>
        <div className="mt-0.5 text-[11px] text-text-secondary">{item.time}</div>
      </div>
    </div>
  )
}

function getEventAction(event: ControlEvent) {
  return String(
    event.action
    || event.activity_type
    || event.event_type
    || (event.type === 'order' ? 'ORDER_UPDATE' : '')
    || event.type
    || '',
  ).toUpperCase()
}

function formatRelativeTime(event: ControlEvent) {
  const raw = event.created_at || event.received_at
  if (raw) {
    const parsed = Date.parse(String(raw))
    if (Number.isFinite(parsed)) return relativeFromMs(parsed)
  }
  const ts = Number(event.timestamp)
  if (Number.isFinite(ts) && ts > 1_000_000_000) {
    return relativeFromMs(ts * 1000)
  }
  return 'Just now'
}

function relativeFromMs(ms: number) {
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (diffSec < 60) return `${Math.max(1, diffSec)} sec ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin} min ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr} hr ago`
  return `${Math.floor(diffHr / 24)} d ago`
}

function mapEventToActivity(event: ControlEvent): ActivityItem {
  const action = getEventAction(event)
  const details = (event.details || event.content || {}) as Record<string, unknown>
  const symbol = String(event.symbol || details.symbol || '').trim()
  const symbolSuffix = symbol ? ` · ${symbol}` : ''

  let type: ActivityItem['type'] = 'info'
  if (action.includes('BUY') || (action.includes('FILLED') && action.includes('LONG'))) type = 'buy'
  else if (
    action.includes('SELL')
    || action.includes('CLOSE')
    || action.includes('TAKE_PROFIT')
    || action.includes('STOP_LOSS')
  ) type = 'sell'

  const title = `${action.replace(/_/g, ' ')}${symbolSuffix}`.trim()
  const detailParts = [
    event.order_id ? `order ${event.order_id}` : '',
    event.executor_id ? `execution ${event.executor_id}` : '',
    details.message ? String(details.message) : '',
    details.reason ? String(details.reason) : '',
  ].filter(Boolean)

  return {
    type,
    title: title || 'Trading event',
    detail: detailParts.join(' · ') || 'Control plane event',
    time: formatRelativeTime(event),
  }
}

export default function DashboardPage() {
  const [savedStrategies, setSavedStrategies] = useState<RunningStrategy[]>([])
  const [strategyMetrics, setStrategyMetrics] = useState<StrategyMetrics>({
    total: 0,
    running: 0,
    stopped: 0,
    pending: 0,
  })
  const [activity, setActivity] = useState<ActivityItem[]>([])

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const [executionsRes, eventsRes] = await Promise.all([
          fetch('/api/control/executions'),
          fetch('/api/control/events?limit=20'),
        ])
        const executionsData = await executionsRes.json()
        const eventsData = await eventsRes.json()

        const allRows = (executionsData.status ? executionsData.data || [] : [])
          .map((item: {
            execution_id: string
            engine?: {
              label?: string
              strategy_name?: string
              symbol?: string
              status?: string
              created_at?: string
              started_at?: string
            }
            executor?: { symbol?: string }
          }) => {
            const status = String(item.engine?.status || 'unknown').toLowerCase()
            return {
              id: item.execution_id,
              name:
                item.engine?.label
                || item.engine?.strategy_name
                || item.engine?.symbol
                || 'Strategy',
              symbol: item.executor?.symbol || item.engine?.symbol || '—',
              status,
              createdAt: item.engine?.created_at,
              startedAt: item.engine?.started_at,
              inPosition: false,
              pnl: 0,
            }
          })
          .sort((a, b) => {
            const createdA = String(a.createdAt || '')
            const createdB = String(b.createdAt || '')
            if (createdA && createdB && createdA !== createdB) {
              return createdB.localeCompare(createdA)
            }
            const liveDelta = Number(['running', 'starting'].includes(b.status))
              - Number(['running', 'starting'].includes(a.status))
            if (liveDelta !== 0) return liveDelta
            return a.name.localeCompare(b.name)
          })

        const recentActivity = (eventsData.status ? eventsData.data || [] : [])
          .slice(0, 4)
          .map(mapEventToActivity)

        if (!cancelled) {
          setSavedStrategies(allRows.slice(0, 5))
          setStrategyMetrics(computeStrategyMetrics(allRows))
          setActivity(recentActivity)
        }
      } catch {
        if (!cancelled) {
          setSavedStrategies([])
          setStrategyMetrics({ total: 0, running: 0, stopped: 0, pending: 0 })
          setActivity([])
        }
      }
    }

    load()
    const intervalId = setInterval(load, 30000)
    return () => {
      cancelled = true
      clearInterval(intervalId)
    }
  }, [])

  return (
    <div className="h-full overflow-auto p-5">
      <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard label="Total saved" value={String(strategyMetrics.total)} />
        <StatCard label="Running now" value={String(strategyMetrics.running)} valueClass="text-green" />
        <StatCard label="Stopped" value={String(strategyMetrics.stopped)} />
        <StatCard label="Pending deploy" value={String(strategyMetrics.pending)} />
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3.5">
          <h3 className="text-[13px] font-semibold">Strategies</h3>
          <Link to="/trade/strategies" className="text-xs font-semibold text-accent hover:underline">
            View all
          </Link>
        </div>
        <div className="overflow-auto">
          <StrategiesTable
            rows={savedStrategies}
            emptyState={<RunningStrategiesEmpty />}
          />
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3.5">
          <h3 className="text-[13px] font-semibold">Recent activity</h3>
          <Link to="/trade/activity" className="text-xs font-semibold text-accent hover:underline">
            Open activity
          </Link>
        </div>
        <div className="px-4">
          {activity.length ? (
            activity.map((item, index) => <ActivityRow key={`${item.title}-${index}`} item={item} />)
          ) : (
            <div className="py-10 text-center text-sm text-text-secondary">
              No recent activity yet.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
