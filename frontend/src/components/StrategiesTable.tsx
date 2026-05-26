import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { formatSignedInr } from '../lib/currency'
import { formatDbTimestamp } from '../lib/datetime'
import { pnlClass } from '../layout/useAccountSummary'

export type StrategyTableRow = {
  id: string
  name: string
  symbol: string
  status: string
  createdAt?: string | null
  scheduledFor?: string | null
  pnl?: number
  inPosition?: boolean
  logFile?: string | null
}

function StatusBadge({ status }: { status: string }) {
  const normalized = status.toLowerCase()
  if (normalized === 'running' || normalized === 'starting') {
    return (
      <span className="rounded-full bg-green/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-green">
        Running
      </span>
    )
  }
  if (normalized === 'scheduled') {
    return (
      <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent">
        Scheduled
      </span>
    )
  }
  return (
    <span className="rounded-full bg-text-secondary/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-text-secondary">
      {status.replace(/_/g, ' ')}
    </span>
  )
}

function StrategyNameCell({
  row,
  onRowClick,
  showExecutionId,
}: {
  row: StrategyTableRow
  onRowClick?: (id: string) => void
  showExecutionId: boolean
}) {
  const content = (
    <>
      <span className="font-semibold text-accent hover:underline">{row.name}</span>
      {showExecutionId ? (
        <span className="mt-0.5 block truncate font-mono text-[10px] text-text-secondary">{row.id}</span>
      ) : null}
    </>
  )

  if (onRowClick) {
    return (
      <button type="button" onClick={() => onRowClick(row.id)} className="block max-w-full text-left">
        {content}
      </button>
    )
  }

  return (
    <Link to={`/trade/strategies/${encodeURIComponent(row.id)}`} className="block max-w-full">
      {content}
    </Link>
  )
}

export function StrategiesTable({
  rows,
  onRowClick,
  onOpenLogs,
  selectedId,
  showExecutionId = true,
  emptyState,
}: {
  rows: StrategyTableRow[]
  onRowClick?: (id: string) => void
  onOpenLogs?: (row: StrategyTableRow) => void
  selectedId?: string | null
  showExecutionId?: boolean
  emptyState?: ReactNode
}) {
  if (!rows.length) return emptyState ?? null

  return (
    <div className="overflow-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="bg-black/15 text-left">
            <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
              Strategy
            </th>
            <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
              Symbol
            </th>
            <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
              Status
            </th>
            <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
              Scheduled for
            </th>
            <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
              Created
            </th>
            <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
              P&amp;L
            </th>
            {onOpenLogs ? (
              <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
                Logs
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr
              key={row.id}
              className={`border-b border-border hover:bg-white/[0.02] ${
                selectedId === row.id ? 'bg-accent/10' : ''
              }`}
            >
              <td className="px-3.5 py-2.5">
                <StrategyNameCell row={row} onRowClick={onRowClick} showExecutionId={showExecutionId} />
              </td>
              <td className="px-3.5 py-2.5 font-mono">{row.symbol}</td>
              <td className="px-3.5 py-2.5">
                <StatusBadge status={row.status} />
                {row.inPosition ? (
                  <span className="ml-1.5 rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-400">
                    In position
                  </span>
                ) : null}
              </td>
              <td className="px-3.5 py-2.5 whitespace-nowrap text-text-secondary">
                {row.status.toLowerCase() === 'scheduled'
                  ? formatDbTimestamp(row.scheduledFor)
                  : '—'}
              </td>
              <td className="px-3.5 py-2.5 whitespace-nowrap text-text-secondary">
                {formatDbTimestamp(row.createdAt)}
              </td>
              <td className={`px-3.5 py-2.5 font-mono ${pnlClass(row.pnl ?? 0)}`}>
                {formatSignedInr(row.pnl ?? 0, { maxFractionDigits: 0 })}
              </td>
              {onOpenLogs ? (
                <td className="px-3.5 py-2.5">
                  <button
                    type="button"
                    onClick={event => {
                      event.stopPropagation()
                      onOpenLogs(row)
                    }}
                    className="inline-flex items-center gap-1.5 rounded border border-accent/40 bg-accent/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-accent hover:bg-accent/20"
                    title={row.logFile || 'Open execution log stream'}
                  >
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                    Logs
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
