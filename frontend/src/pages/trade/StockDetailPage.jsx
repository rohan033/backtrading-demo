import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import LiveLogPanel from '../../components/LiveLogPanel'
import { StrategiesTable } from '../../components/StrategiesTable'
import { TradingActivityFeed } from '../../components/TradingActivityFeed'
import {
  filterExecutionsBySymbolKey,
  groupExecutionsBySymbol,
  normalizeSymbolKey,
} from '../../lib/groupExecutionsBySymbol'
import { executionsToStrategyRows } from '../../lib/strategyRows'
import { useExecution } from '../../ExecutionWorkspace'

export function StockDetailPage() {
  const { symbol: symbolParam } = useParams()
  const navigate = useNavigate()
  const symbolKey = normalizeSymbolKey(symbolParam ? decodeURIComponent(symbolParam) : '')
  const [logTarget, setLogTarget] = useState(null)
  const {
    panelExecutions,
    controlledExecutionsLoading,
    controlledExecutionsError,
    executionEvents,
    refreshControlledExecutions,
    setSelectedExecutionId,
    setSelectedLaunchId,
  } = useExecution()

  useEffect(() => {
    refreshControlledExecutions()
  }, [refreshControlledExecutions])

  const stockExecutions = useMemo(
    () => filterExecutionsBySymbolKey(panelExecutions, symbolKey),
    [panelExecutions, symbolKey],
  )

  const stockSummary = useMemo(() => {
    const groups = groupExecutionsBySymbol(stockExecutions)
    return groups[0] || null
  }, [stockExecutions])

  const rows = useMemo(() => executionsToStrategyRows(stockExecutions), [stockExecutions])

  const stockRealtimeEvents = useMemo(() => {
    const executionIds = new Set(stockExecutions.map(execution => execution.executor_id))
    return executionEvents.filter(event => {
      const execId = event.executor_id || event.details?.executor_id
      if (execId && executionIds.has(execId)) return true
      const eventSymbol = event.symbol || event.details?.symbol
      return eventSymbol && normalizeSymbolKey(eventSymbol) === symbolKey
    })
  }, [executionEvents, stockExecutions, symbolKey])

  const displaySymbol = stockSummary?.symbol || symbolKey

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

      <div className="mb-6">
        <Link
          to="/trade/strategies"
          className="text-[11px] font-semibold text-text-secondary hover:text-accent"
        >
          ← Back to strategies
        </Link>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-mono text-2xl font-bold text-text-primary">{displaySymbol}</h1>
            {stockSummary ? (
              <p className="mt-1 text-sm text-text-secondary">
                {stockSummary.strategyCount} saved
                {' · '}
                {stockSummary.runningCount} running
                {' · '}
                {stockSummary.scheduledCount} scheduled
                {stockSummary.inPositionCount ? ` · ${stockSummary.inPositionCount} in position` : ''}
              </p>
            ) : null}
            {stockSummary?.brokers.length ? (
              <p className="mt-1 text-[11px] text-text-secondary">
                Broker{stockSummary.brokers.length > 1 ? 's' : ''}: {stockSummary.brokers.join(', ')}
              </p>
            ) : null}
          </div>
          <Link
            to="/trade/strategies/new"
            className="shrink-0 rounded-md bg-accent px-4 py-2 text-[11px] font-bold text-white"
          >
            New strategy
          </Link>
        </div>
      </div>

      {controlledExecutionsError ? (
        <div className="mb-4 rounded border border-red/40 bg-red/10 px-4 py-3 text-sm text-red">
          {controlledExecutionsError}
        </div>
      ) : null}

      {controlledExecutionsLoading ? (
        <div className="rounded border border-dashed border-border p-8 text-center text-sm text-text-secondary">
          Loading strategies…
        </div>
      ) : stockExecutions.length ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.8fr)]">
          <section>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">Strategies</h2>
              <span className="text-[11px] text-text-secondary">{rows.length} total</span>
            </div>
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <StrategiesTable
                rows={rows}
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
            </div>
          </section>

          <section>
            <TradingActivityFeed
              title="Recent activity"
              viewAllHref={`/trade/activity?symbol=${encodeURIComponent(displaySymbol)}`}
              symbolKey={displaySymbol}
              realtimeEvents={stockRealtimeEvents}
              limit={40}
              compactLimit={12}
            />
          </section>
        </div>
      ) : (
        <div className="rounded border border-dashed border-border p-8 text-center text-sm text-text-secondary">
          No saved strategies for this stock yet.
        </div>
      )}
    </div>
  )
}
