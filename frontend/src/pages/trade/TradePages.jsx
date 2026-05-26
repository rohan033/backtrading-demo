import { useEffect, useMemo, useState } from 'react'
import { Link, Outlet, useNavigate, useParams } from 'react-router-dom'

import { StopAllStrategiesButton } from '../../components/StopAllStrategiesButton'
import { StrategiesTable } from '../../components/StrategiesTable'
import LiveLogPanel from '../../components/LiveLogPanel'
import StrategyDetailView from './StrategyDetailView'
import {
  CreateExecutionPanel,
  ChartTab,
  EmptyState,
  ExecutionProvider,
  OrderManagementTab,
  TradingEventsTab,
  repairControlledExecution,
  startControlledExecution,
  unscheduleControlledExecution,
  useExecution,
} from '../../ExecutionWorkspace'

const STRATEGIES_PAGE_SIZE = 10

function PaginationBar({ page, pageCount, total, pageSize, onPageChange }) {
  if (pageCount <= 1) return null

  const start = (page - 1) * pageSize + 1
  const end = Math.min(page * pageSize, total)

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
      <p className="text-[11px] text-text-secondary">
        Showing {start}–{end} of {total}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className="rounded border border-border bg-card px-3 py-1.5 text-[11px] font-semibold text-text-secondary hover:text-text-primary disabled:opacity-40"
        >
          Previous
        </button>
        <span className="min-w-[4.5rem] text-center text-[11px] text-text-secondary">
          Page {page} of {pageCount}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pageCount}
          className="rounded border border-border bg-card px-3 py-1.5 text-[11px] font-semibold text-text-secondary hover:text-text-primary disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  )
}

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
  const [filter, setFilter] = useState('all')
  const [page, setPage] = useState(1)
  const [logTarget, setLogTarget] = useState(null)
  const {
    panelExecutions,
    controlledExecutionsLoading,
    controlledExecutionsError,
    setSelectedExecutionId,
    setSelectedLaunchId,
    refreshControlledExecutions,
  } = useExecution()

  useEffect(() => {
    refreshControlledExecutions()
  }, [refreshControlledExecutions])

  useEffect(() => {
    setPage(1)
  }, [filter])

  const rows = useMemo(() => {
    return panelExecutions.map(execution => {
      const engineStatus = String(execution.data_plane_status || execution.status || 'unknown').toLowerCase()
      const isStoppable = ['running', 'starting', 'stale'].includes(engineStatus)
      return {
        id: execution.executor_id,
        name: execution.label || execution.symbol || execution.strategy_name || 'Strategy',
        symbol: execution.symbol || '—',
        status: engineStatus,
        createdAt: execution.created_at,
        scheduledFor: execution.scheduled_start_at || null,
        pnl: 0,
        inPosition: Boolean(execution.is_in_position),
        isLive: isStoppable,
        isScheduled: engineStatus === 'scheduled',
        logFile: execution.log_file || null,
      }
    })
  }, [panelExecutions])

  const filteredRows = useMemo(() => {
    if (filter === 'running') return rows.filter(row => row.isLive)
    if (filter === 'scheduled') return rows.filter(row => row.isScheduled)
    if (filter === 'stopped') return rows.filter(row => !row.isLive && !row.isScheduled)
    return rows
  }, [filter, rows])

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / STRATEGIES_PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)

  const pagedRows = useMemo(() => {
    const start = (currentPage - 1) * STRATEGIES_PAGE_SIZE
    return filteredRows.slice(start, start + STRATEGIES_PAGE_SIZE)
  }, [filteredRows, currentPage])

  const counts = useMemo(() => ({
    all: rows.length,
    running: rows.filter(row => row.isLive).length,
    scheduled: rows.filter(row => row.isScheduled).length,
    stopped: rows.filter(row => !row.isLive && !row.isScheduled).length,
  }), [rows])

  return (
    <div className="h-full overflow-auto p-6">
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
              label: logTarget.label,
              logFile: logTarget.logFile,
              isControlled: true,
            }}
            onClose={() => setLogTarget(null)}
          />
        </>
      ) : null}

      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <p className="text-sm text-text-secondary">
            Saved broker-stock-strategy executions from the control plane, including stopped runs.
          </p>
          {!controlledExecutionsLoading && !controlledExecutionsError ? (
            <p className="mt-1 text-[10px] text-text-secondary">
              {counts.all} saved · {counts.running} running · {counts.scheduled} scheduled · {counts.stopped} stopped
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StopAllStrategiesButton
            alwaysShow
            onComplete={refreshControlledExecutions}
          />
          <Link
            to="/trade/strategies/new"
            className="shrink-0 rounded-md bg-accent px-4 py-2 text-[11px] font-bold text-white"
          >
            New strategy
          </Link>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {[
          { id: 'all', label: `All (${counts.all})` },
          { id: 'running', label: `Running (${counts.running})` },
          { id: 'scheduled', label: `Scheduled (${counts.scheduled})` },
          { id: 'stopped', label: `Stopped (${counts.stopped})` },
        ].map(tab => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setFilter(tab.id)}
            className={`rounded px-3 py-1.5 text-[11px] font-bold transition-colors ${
              filter === tab.id
                ? 'bg-accent text-white'
                : 'bg-card text-text-secondary hover:text-text-primary'
            }`}
          >
            {tab.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => refreshControlledExecutions()}
          disabled={controlledExecutionsLoading}
          className="ml-auto rounded border border-border bg-card px-3 py-1.5 text-[11px] font-semibold text-text-secondary hover:text-text-primary disabled:opacity-50"
        >
          {controlledExecutionsLoading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {controlledExecutionsError ? (
        <div className="mb-4 rounded border border-red/40 bg-red/10 px-4 py-3 text-sm text-red">
          {controlledExecutionsError}
        </div>
      ) : null}

      {controlledExecutionsLoading ? (
        <div className="rounded border border-dashed border-border p-8 text-center text-sm text-text-secondary">
          Loading saved strategies…
        </div>
      ) : filteredRows.length ? (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <StrategiesTable
            rows={pagedRows}
            onRowClick={rowId => {
              setSelectedExecutionId(rowId)
              setSelectedLaunchId(rowId)
              navigate(`/trade/strategies/${encodeURIComponent(rowId)}`)
            }}
            onOpenLogs={row => setLogTarget({
              id: row.id,
              label: row.name,
              logFile: row.logFile,
            })}
          />
          <div className="px-4 pb-4">
            <PaginationBar
              page={currentPage}
              pageCount={pageCount}
              total={filteredRows.length}
              pageSize={STRATEGIES_PAGE_SIZE}
              onPageChange={setPage}
            />
          </div>
        </div>
      ) : (
        <div className="rounded border border-dashed border-border p-8 text-center text-sm text-text-secondary">
          {filter === 'running'
            ? 'No running strategies right now. Open Stopped or All to see saved executions.'
            : 'No strategies yet. Create one to get started.'}
        </div>
      )}
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
  const navigate = useNavigate()
  const [stopping, setStopping] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const [unscheduling, setUnscheduling] = useState(false)
  const [actionError, setActionError] = useState('')
  const {
    panelExecutions,
    controlledExecutions,
    selectedExecutionLive,
    selectedExecution,
    selectedLaunchId,
    setSelectedExecutionId,
    setSelectedLaunchId,
    planeStreams,
    liveApi,
    selectedTick,
    executionEvents,
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

  const execution = selectedExecutionLive || selectedExecution
  const queuedItem = controlledExecutions.find(item => item.execution_id === id)
  const engineStatus = String(
    queuedItem?.engine?.status || execution?.data_plane_status || '',
  ).toLowerCase()
  const isLive = ['running', 'starting'].includes(engineStatus)
  const overviewExecution = useMemo(() => {
    const fromPanel = panelExecutions.find(ex => ex.executor_id === id)
    const base = fromPanel || execution || null
    if (!base || !queuedItem?.engine) return base

    const engine = queuedItem.engine
    return {
      ...base,
      created_at: base.created_at || engine.created_at,
      data_plane_id: base.data_plane_id || engine.id,
      data_plane_port: base.data_plane_port || engine.port,
      data_plane_status: base.data_plane_status || engine.status,
      api_base_url: base.api_base_url || engine.api_base_url,
      ws_url: base.ws_url || engine.ws_url,
      log_file: base.log_file || engine.metadata?.log_file,
    }
  }, [panelExecutions, id, execution, queuedItem])
  const strategyActivityEvents = useMemo(() => {
    if (!id) return []
    return executionEvents.filter(event => {
      const execId = event.executor_id || event.details?.executor_id
      return execId === id
    })
  }, [executionEvents, id])

  const stopStrategy = async () => {
    if (!id) return
    setActionError('')
    setStopping(true)
    try {
      const res = await fetch(`/api/control/executions/${encodeURIComponent(id)}/stop`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Failed to stop strategy')
      await refreshControlledExecutions()
      await onExecutionStopped(id)
    } catch (error) {
      setActionError(error?.message || 'Failed to stop strategy')
    } finally {
      setStopping(false)
    }
  }

  const deployStrategy = async () => {
    if (!id) return
    setActionError('')
    setDeploying(true)
    try {
      const { engine, executor } = await startControlledExecution(id)
      await refreshControlledExecutions()
      await onExecutionStarted(engine, executor)
      await refreshExecutions()
    } catch (error) {
      setActionError(error?.message || 'Failed to deploy strategy')
    } finally {
      setDeploying(false)
    }
  }

  const unscheduleStrategy = async () => {
    if (!id) return
    setActionError('')
    setUnscheduling(true)
    try {
      await unscheduleControlledExecution(id)
      await refreshControlledExecutions()
      await refreshExecutions()
    } catch (error) {
      setActionError(error?.message || 'Failed to unschedule strategy')
    } finally {
      setUnscheduling(false)
    }
  }

  useEffect(() => {
    if (!id || !isLive) return
    let cancelled = false
    ;(async () => {
      try {
        const repaired = await repairControlledExecution(id)
        if (repaired && !cancelled) {
          await refreshControlledExecutions()
          await refreshExecutions()
        }
      } catch {
        // Ignore repair failures; deploy can be retried manually.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id, isLive, refreshControlledExecutions, refreshExecutions])

  const handleDuplicate = async () => {
    setActionError('')
    const item = queuedItem || { execution_id: id }
    const draft = await duplicateExecution(item)
    if (draft) {
      navigate('/trade/strategies/new')
      return
    }
    setActionError('Could not duplicate this strategy. Refresh and try again.')
  }

  return (
    <StrategyDetailView
      executionId={id}
      execution={overviewExecution}
      queuedItem={queuedItem}
      engineStatus={engineStatus}
      isLive={isLive}
      planeStreams={planeStreams}
      selectedTick={selectedTick}
      liveApi={liveApi}
      strategyActivityEvents={strategyActivityEvents}
      onExecutionStarted={onExecutionStarted}
      onExecutionStopped={onExecutionStopped}
      refreshControlledExecutions={refreshControlledExecutions}
      refreshExecutions={refreshExecutions}
      onStop={stopStrategy}
      stopping={stopping}
      onDeploy={deployStrategy}
      deploying={deploying}
      onUnschedule={unscheduleStrategy}
      unscheduling={unscheduling}
      onDuplicate={handleDuplicate}
      actionError={actionError}
    />
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
