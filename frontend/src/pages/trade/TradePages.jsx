import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, Outlet, useNavigate, useParams } from 'react-router-dom'

import {
  ChartTab,
  CreateExecutionPanel,
  EmptyState,
  ExecutionProvider,
  LaunchTab,
  OrderManagementTab,
  StrategyTab,
  TradingEventsTab,
  useExecution,
} from '../../ExecutionWorkspace'

const DETAIL_TABS = [
  { id: 'chart', label: 'Chart' },
  { id: 'overview', label: 'Overview' },
  { id: 'activity', label: 'Activity' },
]

export function TradeLayout() {
  return (
    <ExecutionProvider>
      <div className="h-full overflow-hidden">
        <Outlet />
      </div>
    </ExecutionProvider>
  )
}

export function StrategiesListPage() {
  const navigate = useNavigate()
  const {
    panelExecutions,
    controlledExecutions,
    setSelectedExecutionId,
    setSelectedLaunchId,
    duplicateExecution,
    onExecutionStarted,
    onExecutionStopped,
    refreshControlledExecutions,
  } = useExecution()

  useEffect(() => {
    refreshControlledExecutions()
  }, [refreshControlledExecutions])

  const queued = controlledExecutions.map(item => ({
    id: item.execution_id,
    label: item.engine?.label || item.engine?.strategy_name || item.executor?.symbol || 'Queued strategy',
    symbol: item.executor?.symbol || item.engine?.symbol || '—',
    status: item.engine?.status || 'pending',
    kind: 'queued',
  }))

  const live = panelExecutions.map(execution => ({
    id: execution.executor_id,
    label: execution.label || execution.symbol || execution.strategy_name || 'Strategy',
    symbol: execution.symbol || '—',
    status: execution.data_plane_status || execution.status || 'unknown',
    kind: 'live',
  }))

  const rows = [...queued, ...live]

  return (
    <div className="h-full overflow-auto p-6">
      <div className="mb-6 flex items-center justify-between gap-4">
        <p className="text-sm text-text-secondary">
          Manage queued and running strategies. Open a strategy to chart, review activity, and deploy.
        </p>
        <Link
          to="/trade/strategies/new"
          className="shrink-0 rounded-md bg-accent px-4 py-2 text-[11px] font-bold text-white"
        >
          New strategy
        </Link>
      </div>

      <div className="grid gap-3">
        {rows.length ? rows.map(row => (
          <button
            key={`${row.kind}:${row.id}`}
            type="button"
            onClick={() => {
              if (row.kind === 'live') setSelectedExecutionId(row.id)
              else setSelectedLaunchId(row.id)
              navigate(`/trade/strategies/${encodeURIComponent(row.id)}`)
            }}
            className="flex w-full items-center justify-between rounded border border-border bg-card p-4 text-left transition-colors hover:border-accent/50"
          >
            <div>
              <div className="text-sm font-semibold">{row.label}</div>
              <div className="mt-1 text-[10px] text-text-secondary">{row.symbol}</div>
            </div>
            <span className="rounded bg-secondary px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-text-secondary">
              {String(row.status).replace(/_/g, ' ')}
            </span>
          </button>
        )) : (
          <div className="rounded border border-dashed border-border p-8 text-center text-sm text-text-secondary">
            No strategies yet. Create one to get started.
          </div>
        )}
      </div>
    </div>
  )
}

export function StrategyCreatePage() {
  const navigate = useNavigate()
  const {
    duplicateDraft,
    setDuplicateDraft,
    setShowCreate,
    onExecutionCreated,
    onExecutionStarted,
  } = useExecution()

  useEffect(() => {
    setShowCreate(true)
    return () => setShowCreate(false)
  }, [setShowCreate])

  return (
    <div className="h-full overflow-auto">
      <CreateExecutionPanel
        duplicateDraft={duplicateDraft}
        onCreated={async executionId => {
          await onExecutionCreated(executionId)
          navigate(`/trade/strategies/${encodeURIComponent(executionId)}`)
        }}
        onStarted={async (engine, executor) => {
          await onExecutionStarted(engine, executor)
          if (executor?.executor_id) {
            navigate(`/trade/strategies/${encodeURIComponent(executor.executor_id)}`)
          }
        }}
        onCancel={() => {
          setDuplicateDraft(null)
          setShowCreate(false)
          navigate('/trade/strategies')
        }}
      />
    </div>
  )
}

export function StrategyDetailPage() {
  const { id } = useParams()
  const [section, setSection] = useState('chart')
  const contentRef = useRef(null)
  const {
    panelExecutions,
    controlledExecutions,
    selectedExecutionLive,
    selectedExecution,
    selectedLaunchId,
    setSelectedExecutionId,
    setSelectedLaunchId,
    planeStreams,
    selectedExecutionId,
    liveApi,
    selectedTick,
    executionEvents,
    createExecution,
    refreshExecutions,
    duplicateExecution,
    onExecutionStarted,
    onExecutionStopped,
    refreshControlledExecutions,
  } = useExecution()

  useEffect(() => {
    if (!id) return
    const live = panelExecutions.find(ex => ex.executor_id === id)
    if (live) {
      setSelectedExecutionId(id)
      return
    }
    const queued = controlledExecutions.find(item => item.execution_id === id)
    if (queued) setSelectedLaunchId(id)
  }, [id, panelExecutions, controlledExecutions, setSelectedExecutionId, setSelectedLaunchId])

  useEffect(() => {
    setSection('chart')
  }, [id])

  const execution = selectedExecutionLive || selectedExecution
  const queuedItem = controlledExecutions.find(item => item.execution_id === id)
  const engineStatus = String(
    queuedItem?.engine?.status || execution?.data_plane_status || '',
  ).toLowerCase()
  const isLive = ['running', 'starting'].includes(engineStatus)
  const showDeploy = Boolean(queuedItem) && !isLive
  const strategyExecutions = useMemo(
    () => panelExecutions.filter(ex => ex.executor_id === id),
    [panelExecutions, id],
  )

  const selectSection = nextSection => {
    setSection(nextSection)
    if (contentRef.current) contentRef.current.scrollTop = 0
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-secondary px-4 py-2">
        {DETAIL_TABS.map(tab => (
          <button
            key={tab.id}
            type="button"
            onClick={() => selectSection(tab.id)}
            className={`rounded px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide ${
              section === tab.id ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {tab.label}
          </button>
        ))}
        {execution?.symbol ? (
          <span className="ml-auto text-[10px] text-text-secondary">{execution.symbol}</span>
        ) : null}
      </div>

      <div ref={contentRef} className="min-h-0 flex-1 overflow-auto">
        {section === 'chart' ? (
          isLive ? (
            <ChartTab
              executions={strategyExecutions}
              planeStreams={planeStreams}
              selectedExecutionId={selectedExecutionId || id}
            />
          ) : (
            <EmptyState
              title="Chart unavailable"
              body="Deploy this strategy from the Overview tab to start live price streaming."
              action={showDeploy ? (
                <button
                  type="button"
                  onClick={() => selectSection('overview')}
                  className="rounded bg-accent px-4 py-2 text-xs font-bold text-white"
                >
                  Go to Overview
                </button>
              ) : null}
            />
          )
        ) : null}

        {section === 'overview' ? (
          <div className="space-y-0">
            {showDeploy ? (
              <div className="border-b border-border">
                <LaunchTab
                  executions={controlledExecutions}
                  selectedLaunchId={selectedLaunchId || id}
                  onSelect={setSelectedLaunchId}
                  onStarted={onExecutionStarted}
                  onStopped={onExecutionStopped}
                  onDuplicate={duplicateExecution}
                  onRefresh={refreshControlledExecutions}
                />
              </div>
            ) : null}
            <StrategyTab
              execution={execution}
              latestTick={selectedTick}
              liveApi={liveApi}
              onCreate={createExecution}
              onRefresh={refreshExecutions}
            />
          </div>
        ) : null}

        {section === 'activity' ? (
          <div className="space-y-6 p-4">
            <div>
              <h3 className="mb-3 text-xs font-bold uppercase tracking-[1.5px]">Orders</h3>
              <OrderManagementTab
                globalView={false}
                liveApi={liveApi}
                execution={execution}
                realtimeEvents={executionEvents}
              />
            </div>
            <div>
              <h3 className="mb-3 text-xs font-bold uppercase tracking-[1.5px]">Events</h3>
              <TradingEventsTab
                globalView={false}
                liveApi={liveApi}
                execution={execution}
                realtimeEvents={executionEvents}
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function ActivityPage() {
  const { executionEvents } = useExecution()

  return (
    <div className="h-full space-y-8 overflow-auto p-4">
      <section>
        <h2 className="mb-3 text-sm font-semibold">Orders</h2>
        <OrderManagementTab
          globalView
          liveApi=""
          execution={null}
          realtimeEvents={executionEvents}
        />
      </section>
      <section>
        <h2 className="mb-3 text-sm font-semibold">Trading events</h2>
        <TradingEventsTab
          globalView
          liveApi=""
          execution={null}
          realtimeEvents={executionEvents}
        />
      </section>
    </div>
  )
}

export function ChartsPage() {
  const { panelExecutions, planeStreams, selectedExecutionId } = useExecution()

  return (
    <div className="h-full overflow-auto">
      <ChartTab
        executions={panelExecutions}
        planeStreams={planeStreams}
        selectedExecutionId={selectedExecutionId}
      />
    </div>
  )
}
