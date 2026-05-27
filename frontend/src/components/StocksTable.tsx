import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { formatDbTimestamp } from '../lib/datetime'
import type { StockGroupSummary } from '../lib/groupExecutionsBySymbol'

function CountBadge({ count, tone }: { count: number; tone: 'green' | 'accent' | 'muted' }) {
  if (!count) {
    return <span className="text-text-secondary">—</span>
  }

  const toneClass = tone === 'green'
    ? 'bg-green/15 text-green'
    : tone === 'accent'
      ? 'bg-accent/15 text-accent'
      : 'bg-text-secondary/15 text-text-secondary'

  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${toneClass}`}>
      {count}
    </span>
  )
}

export function StocksTable({
  rows,
  onRowClick,
  emptyState,
}: {
  rows: StockGroupSummary[]
  onRowClick?: (symbolKey: string) => void
  emptyState?: ReactNode
}) {
  if (!rows.length) return emptyState ?? null

  return (
    <div className="overflow-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="bg-black/15 text-left">
            <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
              Stock
            </th>
            <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
              Broker
            </th>
            <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
              Strategies
            </th>
            <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
              Running
            </th>
            <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
              Scheduled
            </th>
            <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
              In position
            </th>
            <th className="px-3.5 py-2.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">
              Latest strategy
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const href = `/trade/stocks/${encodeURIComponent(row.symbolKey)}`
            const content = (
              <>
                <span className="font-semibold text-accent hover:underline">{row.symbol}</span>
                <span className="mt-0.5 block text-[10px] text-text-secondary">
                  {row.strategyCount} saved {row.strategyCount === 1 ? 'strategy' : 'strategies'}
                </span>
              </>
            )

            return (
              <tr key={row.symbolKey} className="border-b border-border hover:bg-white/[0.02]">
                <td className="px-3.5 py-2.5">
                  {onRowClick ? (
                    <button
                      type="button"
                      onClick={() => onRowClick(row.symbolKey)}
                      className="block max-w-full text-left"
                    >
                      {content}
                    </button>
                  ) : (
                    <Link to={href} className="block max-w-full">
                      {content}
                    </Link>
                  )}
                </td>
                <td className="px-3.5 py-2.5 text-text-secondary">
                  {row.brokers.length ? row.brokers.join(', ') : '—'}
                </td>
                <td className="px-3.5 py-2.5">
                  <CountBadge count={row.strategyCount} tone="muted" />
                </td>
                <td className="px-3.5 py-2.5">
                  <CountBadge count={row.runningCount} tone="green" />
                </td>
                <td className="px-3.5 py-2.5">
                  <CountBadge count={row.scheduledCount} tone="accent" />
                </td>
                <td className="px-3.5 py-2.5">
                  <CountBadge count={row.inPositionCount} tone="muted" />
                </td>
                <td className="px-3.5 py-2.5 whitespace-nowrap text-text-secondary">
                  {formatDbTimestamp(row.latestCreatedAt)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
