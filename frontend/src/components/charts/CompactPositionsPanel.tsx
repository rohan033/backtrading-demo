import { useCallback, useEffect, useState } from 'react'

import { computeLivePnl, formatPnl, isOpenPosition } from '../../lib/positionPnl'

type Props = {
  executorId: string
  livePrice?: number | null
}

type PositionRow = {
  position_id: string | number
  state?: string
  remaining_units?: number
  position?: Record<string, unknown>
}

async function closePosition(executorId: string, positionId: string | number) {
  const res = await fetch(
    `/api/control/executions/${encodeURIComponent(executorId)}/positions/${encodeURIComponent(String(positionId))}/close`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ units: null }),
    },
  )
  const data = await res.json()
  if (!res.ok || !data.status) {
    throw new Error(data.detail || data.message || 'Close failed')
  }
}

export default function CompactPositionsPanel({ executorId, livePrice = null }: Props) {
  const [positions, setPositions] = useState<PositionRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [closingAll, setClosingAll] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [closeError, setCloseError] = useState<string | null>(null)

  const fetchPositions = useCallback(async () => {
    if (!executorId) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/control/executions/${encodeURIComponent(executorId)}/positions`)
      const data = await res.json()
      if (data.status) setPositions(data.data || [])
      else setError(data.message || 'Failed to load')
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }, [executorId])

  useEffect(() => {
    fetchPositions()
    const id = window.setInterval(fetchPositions, 10_000)
    return () => window.clearInterval(id)
  }, [fetchPositions])

  const open = positions.filter(p => isOpenPosition(p))

  const executeCloseAll = async () => {
    if (!executorId || !open.length || closingAll) return

    setClosingAll(true)
    setCloseError(null)
    setConfirmClose(false)
    try {
      for (const position of open) {
        await closePosition(executorId, position.position_id)
      }
      await fetchPositions()
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : 'Failed to close positions')
      await fetchPositions()
    } finally {
      setClosingAll(false)
    }
  }

  if (loading && !positions.length) {
    return (
      <div className="flex h-full items-center justify-center px-2 text-center text-[10px] text-text-secondary">
        Loading…
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 px-2 text-center text-[10px] text-red">
        <span>{error}</span>
        <button type="button" className="underline" onClick={fetchPositions}>Retry</button>
      </div>
    )
  }

  if (!open.length) {
    return (
      <div className="flex h-full items-center justify-center px-2 text-center text-[10px] text-text-secondary">
        No open positions
      </div>
    )
  }

  const liveRows = open.map(p => ({ position: p, live: computeLivePnl(p, livePrice) }))
  const totalPnl = liveRows.some(row => row.live != null)
    ? liveRows.reduce((sum, row) => sum + (row.live?.pnl ?? 0), 0)
    : null

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-border/60 bg-background/40">
      {totalPnl != null ? (
        <div
          className={`shrink-0 border-b border-border/50 px-2 py-1.5 text-center font-mono text-[11px] font-bold ${
            totalPnl >= 0 ? 'text-green' : 'text-red'
          }`}
        >
          {formatPnl(totalPnl)}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5 space-y-1.5">
        {liveRows.map(({ position, live }) => {
          const pos = position.position || {}
          const units = position.remaining_units ?? (pos.remainingUnits as number | undefined) ?? null
          const posId = position.position_id

          return (
            <div key={String(posId)} className="rounded border border-border/50 bg-card/60 px-1.5 py-1">
              <div className="flex items-center justify-between gap-1">
                <span className="font-mono text-[9px] text-text-secondary">#{posId}</span>
                {live ? (
                  <span className={`font-mono text-[10px] font-semibold ${live.pnl >= 0 ? 'text-green' : 'text-red'}`}>
                    {formatPnl(live.pnl)}
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 font-mono text-[9px] text-text-secondary">
                {units != null ? Number(units).toFixed(3) : '—'} units
              </div>
            </div>
          )
        })}
      </div>
      <div className="shrink-0 border-t border-border/50 p-1.5">
        {closeError ? (
          <p className="mb-1 text-center text-[9px] text-red">{closeError}</p>
        ) : null}
        {confirmClose ? (
          <div className="space-y-1">
            <p className="text-center text-[9px] text-text-secondary">
              Close {open.length} position{open.length !== 1 ? 's' : ''}?
            </p>
            <div className="flex gap-1">
              <button
                type="button"
                disabled={closingAll}
                onClick={executeCloseAll}
                className="flex-1 rounded border border-red/50 bg-red/15 px-1 py-1 text-[9px] font-semibold text-red disabled:opacity-50"
              >
                {closingAll ? 'Closing…' : 'Yes'}
              </button>
              <button
                type="button"
                disabled={closingAll}
                onClick={() => setConfirmClose(false)}
                className="flex-1 rounded border border-border px-1 py-1 text-[9px] text-text-secondary disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={closingAll}
            onClick={() => setConfirmClose(true)}
            className="w-full rounded border border-red/40 bg-red/10 px-1.5 py-1 text-[9px] font-semibold text-red transition-opacity hover:bg-red/15 disabled:opacity-50"
          >
            Close all
          </button>
        )}
      </div>
    </div>
  )
}
