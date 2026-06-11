import { useCallback, useEffect, useMemo, useState } from 'react'
import { Archive, Plus, X } from 'lucide-react'

import DraggableWatchlistCard from '../../components/watchlist/DraggableWatchlistCard'
import WatchlistColumn from '../../components/watchlist/WatchlistColumn'
import WatchlistColumnPicker from '../../components/watchlist/WatchlistColumnPicker'
import WatchlistMomentumSettings from '../../components/watchlist/WatchlistMomentumSettings'
import { Button } from '../../components/ui/button'
import {
  useMomentumNotificationPermission,
  useWatchlistMomentumAlerts,
  type SymbolArchivedCallback,
} from '../../hooks/useWatchlistMomentumAlerts'
import type { DeployAllContext } from '../../components/watchlist/WatchlistColumn'
import { showPlatformToast } from '../../lib/platform-toast'
import { createAndStartMomentumStrategy } from '../../lib/watchlistMomentumStrategy'
import { watchlistTickKey } from '../../lib/watchlists'
import { useWatchlistHistorySeeder } from '../../hooks/useWatchlistHistorySeeder'
import { useWatchlistPriceHistory } from '../../hooks/useWatchlistPriceHistory'
import { useWatchlistTicks } from '../../hooks/useWatchlistTicks'
import { loadMomentumConfig, type MomentumConfig } from '../../lib/watchlistMomentum'
import {
  loadVisibleChangeColumns,
  saveVisibleChangeColumns,
  watchlistTableMinWidthPx,
  type WatchlistChangeWindowId,
} from '../../lib/watchlistChangeColumns'
import type { WatchlistBroker } from '../../lib/watchlistBrokers'
import { defaultAccountEnv } from '../../lib/watchlistBrokers'
import {
  canvasMinSize,
  cardWidthForTable,
  layoutForNewWatchlist,
  loadWatchlistLayouts,
  mergeLayouts,
  saveWatchlistLayouts,
  type WatchlistCardLayout,
  type WatchlistCardMetrics,
  type WatchlistLayoutMap,
} from '../../lib/watchlistLayout'
import { errorMessage } from '../../lib/apiError'
import {
  addWatchlistSymbol,
  createWatchlist,
  deleteWatchlist,
  fetchWatchlists,
  removeWatchlistSymbol,
  updateWatchlist,
  type Watchlist,
  type WatchlistSymbol,
} from '../../lib/watchlists'
import {
  applySymbolOrder,
  archiveSymbol,
  clearArchivedSymbols,
  loadArchivedSymbols,
  loadMomentumWatchlistIds,
  loadSymbolOrder,
  removeArchivedSymbol,
  saveSymbolOrder,
  toggleMomentumWatchlistId,
  type ArchivedMomentumSymbol,
} from '../../lib/watchlistMomentumState'

export default function WatchlistPage() {
  const [watchlists, setWatchlists] = useState<Watchlist[]>([])
  const [layouts, setLayouts] = useState<WatchlistLayoutMap>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [cardMetrics, setCardMetrics] = useState<Record<string, WatchlistCardMetrics>>({})
  const [visibleChangeColumns, setVisibleChangeColumns] = useState<WatchlistChangeWindowId[]>(
    () => loadVisibleChangeColumns(),
  )
  const [momentumConfig, setMomentumConfig] = useState<MomentumConfig>(() => loadMomentumConfig())

  // Momentum-trade watchlist state (all persisted in localStorage)
  const [momentumWatchlistIds, setMomentumWatchlistIds] = useState<Set<string>>(
    () => loadMomentumWatchlistIds(),
  )
  const [symbolOrders, setSymbolOrders] = useState<Record<string, string[]>>(() => {
    // Pre-load any saved orders when the component mounts (watchlists aren't loaded yet,
    // but we keep a partial map and fill it in after load)
    return {}
  })
  const [archivedSymbols, setArchivedSymbols] = useState<ArchivedMomentumSymbol[]>(
    () => loadArchivedSymbols(),
  )

  const hasSymbols = watchlists.some(wl => wl.symbols.length > 0)
  const { ticks, connected } = useWatchlistTicks(watchlists, hasSymbols)
  const { windowChanges, historyRef, forceRecompute } = useWatchlistPriceHistory(ticks)

  // Pre-seed local price history from candle data so % changes are visible immediately on load
  useWatchlistHistorySeeder(watchlists, historyRef, forceRecompute)

  /** Returns symbols for a watchlist with any saved order applied. */
  const orderedSymbolsFor = useCallback(
    (wl: Watchlist): WatchlistSymbol[] =>
      applySymbolOrder(wl.symbols, symbolOrders[wl.id] ?? null),
    [symbolOrders],
  )

  /** Stable map of ordered symbols used by the momentum hook — only recomputes when watchlists or orders change. */
  const allOrderedSymbols = useMemo(
    () => Object.fromEntries(watchlists.map(wl => [wl.id, orderedSymbolsFor(wl)])),
    [watchlists, orderedSymbolsFor],
  )

  const handleToggleMomentum = useCallback((watchlistId: string) => {
    setMomentumWatchlistIds(prev => toggleMomentumWatchlistId(prev, watchlistId))
  }, [])

  const handleSymbolsReordered = useCallback((watchlistId: string, tokens: string[]) => {
    saveSymbolOrder(watchlistId, tokens)
    setSymbolOrders(prev => ({ ...prev, [watchlistId]: tokens }))
  }, [])

  const handleSymbolArchived: SymbolArchivedCallback = useCallback(params => {
    const archived = archiveSymbol({ ...params, archivedAt: Date.now() })
    setArchivedSymbols(archived)
    // Remove the symbol from the watchlist (backend + state)
    void removeWatchlistSymbol(params.watchlistId, params.symboltoken).then(updated => {
      setWatchlists(prev => prev.map(wl => (wl.id === params.watchlistId ? updated : wl)))
    }).catch(() => {
      // Still update local state even if the API call fails
      setWatchlists(prev =>
        prev.map(wl =>
          wl.id === params.watchlistId
            ? { ...wl, symbols: wl.symbols.filter(s => s.symboltoken !== params.symboltoken) }
            : wl,
        ),
      )
    })
  }, [])

  useWatchlistMomentumAlerts({
    watchlists,
    momentumWatchlistIds,
    orderedSymbols: allOrderedSymbols,
    ticks,
    windowChanges,
    historyRef,
    enabled: hasSymbols && connected,
    config: momentumConfig,
    onSymbolArchived: handleSymbolArchived,
  })
  useMomentumNotificationPermission(momentumConfig.enabled && hasSymbols)

  const tableMinWidth = watchlistTableMinWidthPx(visibleChangeColumns.length)

  const handleVisibleChangeColumns = useCallback((next: WatchlistChangeWindowId[]) => {
    setVisibleChangeColumns(next)
    saveVisibleChangeColumns(next)
  }, [])

  useEffect(() => {
    setLayouts(prev => {
      let changed = false
      const next: WatchlistLayoutMap = { ...prev }
      for (const [id, layout] of Object.entries(next)) {
        const width = cardWidthForTable(visibleChangeColumns.length, layout.width)
        if (width !== layout.width) {
          next[id] = { ...layout, width }
          changed = true
        }
      }
      if (!changed) return prev
      saveWatchlistLayouts(next)
      return next
    })
  }, [visibleChangeColumns])

  const persistLayouts = useCallback((next: WatchlistLayoutMap) => {
    setLayouts(next)
    saveWatchlistLayouts(next)
  }, [])

  const load = useCallback(async () => {
    setError(null)
    try {
      const rows = await fetchWatchlists()
      setWatchlists(rows)
      // Restore saved symbol orders for all watchlists
      const orders: Record<string, string[]> = {}
      for (const wl of rows) {
        const order = loadSymbolOrder(wl.id)
        if (order) orders[wl.id] = order
      }
      setSymbolOrders(orders)
      const stored = loadWatchlistLayouts()
      const merged = mergeLayouts(rows.map(r => r.id), stored)
      const columns = loadVisibleChangeColumns()
      const sized = Object.fromEntries(
        Object.entries(merged).map(([id, layout]) => [
          id,
          { ...layout, width: cardWidthForTable(columns.length, layout.width) },
        ]),
      )
      persistLayouts(sized)
    } catch (e) {
      setError(errorMessage(e, 'Failed to load watchlists'))
    } finally {
      setLoading(false)
    }
  }, [persistLayouts])

  useEffect(() => {
    load()
  }, [load])

  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const handleCreate = () =>
    wrap(async () => {
      const created = await createWatchlist(`Watchlist ${watchlists.length + 1}`, {
        broker: 'angel',
      })
      const nextLayouts = {
        ...layouts,
        [created.id]: {
          ...layoutForNewWatchlist(layouts, cardMetrics, created.id),
          width: cardWidthForTable(visibleChangeColumns.length),
        },
      }
      setWatchlists(prev => [...prev, created])
      persistLayouts(nextLayouts)
    })

  const handleRename = (id: string, name: string) =>
    wrap(async () => {
      const updated = await updateWatchlist(id, { name })
      setWatchlists(prev => prev.map(wl => (wl.id === id ? updated : wl)))
    })

  const handleBrokerChange = (id: string, broker: WatchlistBroker, accountEnv: string) =>
    wrap(async () => {
      const updated = await updateWatchlist(id, { broker, account_env: accountEnv })
      setWatchlists(prev => prev.map(wl => (wl.id === id ? updated : wl)))
    })

  const handleDelete = (id: string) =>
    wrap(async () => {
      await deleteWatchlist(id)
      setWatchlists(prev => prev.filter(wl => wl.id !== id))
      const next = { ...layouts }
      delete next[id]
      persistLayouts(next)
      setCardMetrics(prev => {
        const metrics = { ...prev }
        delete metrics[id]
        return metrics
      })
    })

  const handleAddSymbol = (
    watchlistId: string,
    hit: { symboltoken: string; tradingsymbol: string; exchange: string },
  ) =>
    wrap(async () => {
      const updated = await addWatchlistSymbol(watchlistId, hit)
      setWatchlists(prev => prev.map(wl => (wl.id === watchlistId ? updated : wl)))
    })

  const handleRemoveSymbol = (watchlistId: string, symboltoken: string) =>
    wrap(async () => {
      const updated = await removeWatchlistSymbol(watchlistId, symboltoken)
      setWatchlists(prev => prev.map(wl => (wl.id === watchlistId ? updated : wl)))
    })

  const handleDeployAll = async (ctx: DeployAllContext) => {
    const accountEnv = ctx.accountEnv as 'live' | 'demo'
    let ok = 0
    let fail = 0
    await Promise.allSettled(
      ctx.symbols.map(async sym => {
        const tickKey = watchlistTickKey(ctx.broker, accountEnv, sym.symboltoken)
        const ltp = ctx.ticks[tickKey]?.ltp
        if (!ltp) { fail++; return }
        try {
          await createAndStartMomentumStrategy(
            {
              broker: ctx.broker,
              tradingsymbol: sym.tradingsymbol,
              token: sym.symboltoken,
              exchange: sym.exchange,
              closePrice: ltp,
            },
            accountEnv,
            momentumConfig,
          )
          ok++
        } catch {
          fail++
        }
      }),
    )
    showPlatformToast({
      variant: fail === 0 ? 'success' : ok > 0 ? 'warning' : 'error',
      title: `Deploy All · ${accountEnv}`,
      message: fail === 0
        ? `${ok} strateg${ok === 1 ? 'y' : 'ies'} started`
        : `${ok} started · ${fail} failed (no live price?)`,
      duration: 8000,
    })
  }

  const handleLayoutChange = (id: string, next: WatchlistCardLayout) => {
    persistLayouts({
      ...layouts,
      [id]: {
        ...next,
        width: cardWidthForTable(visibleChangeColumns.length, next.width),
      },
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
        <div>
          <h1 className="text-sm font-semibold">Watchlists</h1>
          <p className="mt-0.5 text-[11px] text-text-secondary">
            Cards grow with your symbols · drag to rearrange · resize width on the right edge
            {hasSymbols && (
              <span className="ml-2">
                {connected ? '· Live' : '· Connecting…'}
                {momentumConfig.enabled ? ' · Momentum on' : ''}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <WatchlistMomentumSettings onChange={setMomentumConfig} />
          <WatchlistColumnPicker
            visibleColumns={visibleChangeColumns}
            onChange={handleVisibleChangeColumns}
          />
          <Button type="button" size="sm" onClick={handleCreate} disabled={busy} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" />
            New watchlist
          </Button>
        </div>
      </div>

      {error && (
        <div className="mx-5 mt-3 flex items-start justify-between gap-3 rounded border border-red/30 bg-red/10 px-3 py-2 text-xs text-red">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="shrink-0 text-[10px] text-red/80 hover:text-red"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-auto bg-primary/30">
        {loading ? (
          <p className="p-5 text-xs text-text-secondary">Loading watchlists…</p>
        ) : watchlists.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <p className="text-sm text-text-secondary">No watchlists yet.</p>
            <Button type="button" onClick={handleCreate} disabled={busy} className="gap-1.5">
              <Plus className="h-4 w-4" />
              Create your first watchlist
            </Button>
          </div>
        ) : (
          <div
            className="relative p-5"
            style={{
              minWidth: canvasMinSize(layouts, cardMetrics).width,
              minHeight: Math.max(480, canvasMinSize(layouts, cardMetrics).height),
            }}
          >
            {archivedSymbols.length > 0 && (
              <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/5">
                <div className="flex items-center justify-between border-b border-amber-500/20 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Archive className="h-3.5 w-3.5 text-amber-400" />
                    <span className="text-xs font-semibold text-amber-300">
                      Momentum Archive · {archivedSymbols.length} deployed
                    </span>
                    <span className="text-[10px] text-text-secondary">
                      read-only · strategies running
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setArchivedSymbols(clearArchivedSymbols())}
                    className="text-[10px] text-text-secondary hover:text-red"
                  >
                    Clear all
                  </button>
                </div>
                <div className="flex flex-wrap gap-2 px-3 py-2">
                  {archivedSymbols.map(sym => (
                    <div
                      key={`${sym.watchlistId}-${sym.symboltoken}`}
                      className="flex items-center gap-1.5 rounded-md border border-amber-500/20 bg-secondary/60 px-2.5 py-1.5"
                    >
                      <span className="font-sans text-[13px] font-semibold text-text-primary">
                        {sym.tradingsymbol}
                      </span>
                      <span className="text-[11px] text-text-secondary">
                        @ {sym.entryPrice.toFixed(2)}
                      </span>
                      <span className="text-[10px] text-amber-400/70">
                        {new Date(sym.archivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <button
                        type="button"
                        title="Remove from archive"
                        onClick={() =>
                          setArchivedSymbols(removeArchivedSymbol(sym.symboltoken, sym.watchlistId))
                        }
                        className="ml-0.5 text-text-secondary/50 hover:text-red"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {watchlists.map(wl => {
              const layout = layouts[wl.id] ?? mergeLayouts([wl.id], layouts)[wl.id]
              const metrics = cardMetrics[wl.id] ?? {
                symbolCount: wl.symbols.length,
                searchOpen: false,
              }
              return (
                <DraggableWatchlistCard
                  key={wl.id}
                  layout={layout}
                  symbolCount={metrics.symbolCount}
                  searchOpen={metrics.searchOpen}
                  minTableWidth={tableMinWidth}
                  onLayoutChange={next => handleLayoutChange(wl.id, next)}
                >
                  <WatchlistColumn
                    watchlist={{
                      ...wl,
                      broker: (wl.broker || 'angel') as WatchlistBroker,
                      account_env: wl.account_env || defaultAccountEnv((wl.broker || 'angel') as WatchlistBroker),
                    }}
                    orderedSymbols={orderedSymbolsFor(wl)}
                    ticks={ticks}
                    windowChanges={windowChanges}
                    visibleChangeColumns={visibleChangeColumns}
                    isMomentumWatchlist={momentumWatchlistIds.has(wl.id)}
                    onToggleMomentum={handleToggleMomentum}
                    onRename={handleRename}
                    onDelete={handleDelete}
                    onBrokerChange={handleBrokerChange}
                    onDeployAll={handleDeployAll}
                    onAddSymbol={handleAddSymbol}
                    onRemoveSymbol={handleRemoveSymbol}
                    onSymbolsReordered={handleSymbolsReordered}
                    onMetricsChange={next =>
                      setCardMetrics(prev => ({ ...prev, [wl.id]: next }))
                    }
                  />
                </DraggableWatchlistCard>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
