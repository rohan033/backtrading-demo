import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, PanelRightClose } from 'lucide-react'

import { useWatchlistStream } from '../../context/WatchlistStreamContext'
import { useWatchlistDock } from '../../layout/watchlist-dock-context'
import { formatBrokerMoney } from '../../lib/currency'
import { defaultAccountEnv, type WatchlistBroker } from '../../lib/watchlistBrokers'
import {
  loadAllHiddenSymbolTokens,
  visibleWatchlistSymbols,
  WL_HIDDEN_SYMBOLS_CHANGED_EVENT,
} from '../../lib/watchlistHiddenSymbols'
import {
  formatWindowChangePct,
  WATCHLIST_CHANGE_WINDOWS,
  type WatchlistChangeWindowId,
} from '../../lib/watchlistChangeColumns'
import { applySymbolOrder, loadSymbolOrder } from '../../lib/watchlistMomentumState'
import { watchlistTickKey, type WatchlistSymbol } from '../../lib/watchlists'
import {
  DOCK_CHANGE_COLUMNS,
  loadCollapsedWatchlists,
  loadWatchlistDockSort,
  nextDockSort,
  saveWatchlistDockSort,
  sortDockSymbols,
  toggleCollapsedWatchlist,
  type DockSort,
} from '../../lib/watchlistDockSort'

const WINDOW_LABELS = new Map<WatchlistChangeWindowId, string>(
  WATCHLIST_CHANGE_WINDOWS.map(window => [window.id, window.label]),
)

const COLUMN_GRID = `minmax(0,1fr) 3.25rem repeat(${DOCK_CHANGE_COLUMNS.length}, 2.75rem)`

function windowBadgeClass(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return 'text-text-secondary/45'
  const abs = Math.abs(value)
  const up = value > 0
  if (abs >= 3) {
    return up
      ? 'text-white bg-green font-bold shadow-[0_0_6px_1px_rgba(0,200,83,0.4)]'
      : 'text-white bg-red font-bold shadow-[0_0_6px_1px_rgba(255,23,68,0.4)]'
  }
  if (abs >= 1) {
    return up ? 'text-green bg-green/15 font-semibold' : 'text-red bg-red/15 font-semibold'
  }
  if (abs === 0) return 'text-text-secondary'
  return up ? 'text-green/80' : 'text-red/80'
}

export default function WatchlistDock() {
  const { open, setOpen } = useWatchlistDock()
  // Reuses the shared watchlist stream (same ticks + rolling-window changes that
  // power the sticky feed) — no extra WebSocket connection is opened here.
  const { watchlists, ticks, windowChanges, connected, hasSymbols } = useWatchlistStream()
  const [sort, setSort] = useState<DockSort>(() => loadWatchlistDockSort())
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsedWatchlists())
  const [hiddenByWatchlist, setHiddenByWatchlist] = useState(() => loadAllHiddenSymbolTokens())

  useEffect(() => {
    const refresh = () => setHiddenByWatchlist(loadAllHiddenSymbolTokens())
    window.addEventListener(WL_HIDDEN_SYMBOLS_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(WL_HIDDEN_SYMBOLS_CHANGED_EVENT, refresh)
  }, [])

  const groups = useMemo(
    () =>
      [...watchlists]
        .sort((a, b) => a.position - b.position)
        .map(wl => {
          const broker = (wl.broker || 'angel') as WatchlistBroker
          const accountEnv = wl.account_env || defaultAccountEnv(broker)
          const ordered = applySymbolOrder(wl.symbols, loadSymbolOrder(wl.id))
          const visible = visibleWatchlistSymbols(ordered, wl.id, hiddenByWatchlist[wl.id])
          const symbols = sortDockSymbols(visible, broker, accountEnv, windowChanges, sort)
          return { id: wl.id, name: wl.name, broker, accountEnv, symbols }
        }),
    [watchlists, windowChanges, sort, hiddenByWatchlist],
  )

  const totalSymbols = useMemo(
    () =>
      watchlists.reduce(
        (sum, wl) => sum + visibleWatchlistSymbols(wl.symbols, wl.id, hiddenByWatchlist[wl.id]).length,
        0,
      ),
    [watchlists, hiddenByWatchlist],
  )

  if (!open) return null

  const handleSort = (column: WatchlistChangeWindowId) => {
    setSort(prev => {
      const next = nextDockSort(prev, column)
      saveWatchlistDockSort(next)
      return next
    })
  }

  const handleToggleCollapsed = (watchlistId: string) => {
    setCollapsed(prev => toggleCollapsedWatchlist(prev, watchlistId))
  }

  return (
    <aside className="relative z-20 flex h-full w-[340px] shrink-0 flex-col border-l border-border bg-secondary">
      <div className="flex h-16 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate font-display text-[15px] font-bold tracking-tightest text-text-primary">
            Watchlists
          </h2>
          {hasSymbols && (
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em] ${
                connected
                  ? 'border-green/30 bg-green/10 text-green'
                  : 'border-accent/30 bg-accent/10 text-accent'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-green' : 'bg-accent'}`} />
              {connected ? 'Live' : '…'}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close watchlist panel"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-md border border-border bg-card text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>

      <div
        className="grid shrink-0 items-center gap-x-1.5 border-b border-border bg-secondary/80 px-4 py-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-text-secondary/70"
        style={{ gridTemplateColumns: COLUMN_GRID }}
      >
        <span>Symbol</span>
        <span className="text-right">Last</span>
        {DOCK_CHANGE_COLUMNS.map(columnId => {
          const active = sort?.column === columnId
          const arrow = !active ? '⇅' : sort?.dir === 'desc' ? '▼' : '▲'
          return (
            <button
              key={columnId}
              type="button"
              onClick={() => handleSort(columnId)}
              title={`Sort by ${WINDOW_LABELS.get(columnId)} change`}
              className={`flex items-center justify-end gap-0.5 rounded transition-colors ${
                active ? 'text-accent' : 'text-text-secondary/70 hover:text-text-primary'
              }`}
            >
              <span>{WINDOW_LABELS.get(columnId)}</span>
              <span className={`text-[8px] ${active ? 'text-accent' : 'text-text-secondary/40'}`}>
                {arrow}
              </span>
            </button>
          )
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {totalSymbols === 0 ? (
          <div className="px-4 py-10 text-center text-xs text-text-secondary">
            {watchlists.length === 0
              ? 'No watchlists yet. Create one to see it here.'
              : 'Your watchlists have no symbols yet.'}
          </div>
        ) : (
          groups.map(group => {
            const isCollapsed = collapsed.has(group.id)
            return (
              <section key={group.id}>
                <button
                  type="button"
                  onClick={() => handleToggleCollapsed(group.id)}
                  aria-expanded={!isCollapsed}
                  title={isCollapsed ? 'Show watchlist' : 'Hide watchlist'}
                  className="sticky top-0 z-10 flex w-full items-center gap-2 border-y border-border bg-card/95 px-4 py-1.5 text-left backdrop-blur-sm transition-colors hover:bg-card-hi"
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
                  )}
                  <span className="h-3.5 w-1 rounded-full bg-accent" aria-hidden="true" />
                  <span className="truncate font-display text-[12px] font-bold tracking-tightest text-text-primary">
                    {group.name}
                  </span>
                  <span className="ml-auto rounded-full bg-muted/40 px-1.5 py-0.5 text-[9px] font-bold tabular-nums text-text-secondary">
                    {group.symbols.length}
                  </span>
                </button>

                {!isCollapsed &&
                  (group.symbols.length === 0 ? (
                    <div className="px-4 py-3 text-[11px] text-text-secondary/70">No symbols</div>
                  ) : (
                    group.symbols.map((symbol: WatchlistSymbol) => {
                      const tickKey = watchlistTickKey(
                        group.broker,
                        group.accountEnv,
                        symbol.symboltoken,
                      )
                      const tick = ticks[tickKey]
                      const symbolWindows = windowChanges[tickKey]
                      return (
                        <div
                          key={symbol.symboltoken}
                          className="grid items-center gap-x-1.5 border-b border-border/30 px-4 py-1.5 transition-colors hover:bg-accent/[0.04]"
                          style={{ gridTemplateColumns: COLUMN_GRID }}
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-card-hi text-[10px] font-bold text-text-secondary ring-1 ring-inset ring-white/[0.04]">
                              {symbol.tradingsymbol.charAt(0)}
                            </span>
                            <span
                              className="min-w-0 truncate font-sans text-[13px] font-semibold text-text-primary"
                              title={symbol.tradingsymbol}
                            >
                              {symbol.tradingsymbol}
                            </span>
                          </div>
                          <span className="text-right font-sans text-[12px] font-medium tabular-nums text-text-primary">
                            {tick ? formatBrokerMoney(group.broker, tick.ltp, 2) : '…'}
                          </span>
                          {DOCK_CHANGE_COLUMNS.map(columnId => {
                            const value = symbolWindows?.[columnId] ?? null
                            return (
                              <span
                                key={columnId}
                                className={`rounded px-1 py-0.5 text-right font-sans text-[10.5px] tabular-nums tracking-tight ${windowBadgeClass(value)}`}
                              >
                                {formatWindowChangePct(value)}
                              </span>
                            )
                          })}
                        </div>
                      )
                    })
                  ))}
              </section>
            )
          })
        )}
      </div>
    </aside>
  )
}
