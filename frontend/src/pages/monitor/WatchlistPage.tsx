import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LayoutGrid, Plus, Upload, X, Zap } from 'lucide-react'

import DraggableWatchlistCard from '../../components/watchlist/DraggableWatchlistCard'
import WatchlistColumn from '../../components/watchlist/WatchlistColumn'
import BulkUploadWatchlistDialog, {
  type BulkUploadHandler,
} from '../../components/watchlist/BulkUploadWatchlistDialog'
import WatchlistColumnPicker from '../../components/watchlist/WatchlistColumnPicker'
import WatchlistAutoSort from '../../components/watchlist/WatchlistAutoSort'
import WatchlistMomentumSettings from '../../components/watchlist/WatchlistMomentumSettings'
import { Button } from '../../components/ui/button'
import { useWatchlistStream } from '../../context/WatchlistStreamContext'
import { buildMomentumSymbolIndex } from '../../hooks/useWatchlistMomentumAlerts'
import type { DeployAllContext } from '../../components/watchlist/WatchlistColumn'
import { showPlatformToast } from '../../lib/platform-toast'
import { createAndStartMomentumStrategy } from '../../lib/watchlistMomentumStrategy'
import { watchlistTickKey } from '../../lib/watchlists'
import {
  loadWatchlistAutoSortConfig,
  sortSymbolsByWindowChange,
  type WatchlistAutoSortConfig,
} from '../../lib/watchlistAutoSort'
import { loadMomentumConfig, type MomentumConfig } from '../../lib/watchlistMomentum'
import {
  loadVisibleChangeColumns,
  saveVisibleChangeColumns,
  watchlistTableMinWidthPx,
  type WatchlistChangeWindowId,
} from '../../lib/watchlistChangeColumns'
import type { WatchlistBroker } from '../../lib/watchlistBrokers'
import {
  defaultAccountEnv,
  pickWatchlistSymbolMatch,
  searchWatchlistSymbol,
} from '../../lib/watchlistBrokers'
import {
  canvasMinSize,
  cardHeightForContent,
  cardWidthForTable,
  clampWidth,
  GRID_GAP_X,
  GRID_GAP_Y,
  GRID_ORIGIN_X,
  GRID_ORIGIN_Y,
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
  hideWatchlistSymbol,
  isWatchlistSymbolHidden,
  loadAllHiddenSymbolTokens,
  unhideWatchlistSymbol,
  visibleWatchlistSymbols,
  WL_HIDDEN_SYMBOLS_CHANGED_EVENT,
} from '../../lib/watchlistHiddenSymbols'
import {
  addWatchlistSymbol,
  createWatchlist,
  deleteWatchlist,
  updateWatchlist,
  type Watchlist,
  type WatchlistSymbol,
} from '../../lib/watchlists'
import {
  applySymbolOrder,
  clearMomentumTrades,
  loadMomentumLiveSymbolKeys,
  loadMomentumNoTpSymbolKeys,
  loadMomentumSymbolKeys,
  loadMomentumTrades,
  loadMomentumWatchlistIds,
  loadSymbolOrder,
  notifyMomentumStateChanged,
  removeMomentumTrade,
  saveSymbolOrder,
  setMomentumSymbolMode,
  toggleMomentumLiveSymbolKey,
  toggleMomentumWatchlistId,
  WL_MOMENTUM_CHANGED_EVENT,
  WL_MOMENTUM_TRADE_EVENT,
  type MomentumTrade,
} from '../../lib/watchlistMomentumState'

export default function WatchlistPage() {
  const {
    watchlists,
    setWatchlists,
    watchlistsReady,
    ticks,
    connected,
    hasSymbols,
    windowChanges,
    historyRef,
  } = useWatchlistStream()
  const [layouts, setLayouts] = useState<WatchlistLayoutMap>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [cardMetrics, setCardMetrics] = useState<Record<string, WatchlistCardMetrics>>({})
  const [visibleChangeColumns, setVisibleChangeColumns] = useState<WatchlistChangeWindowId[]>(
    () => loadVisibleChangeColumns(),
  )
  const [momentumConfig, setMomentumConfig] = useState<MomentumConfig>(() => loadMomentumConfig())
  const [autoSortConfig, setAutoSortConfig] = useState<WatchlistAutoSortConfig>(
    () => loadWatchlistAutoSortConfig(),
  )

  // Momentum-trade watchlist state (all persisted in localStorage)
  const [momentumWatchlistIds, setMomentumWatchlistIds] = useState<Set<string>>(
    () => loadMomentumWatchlistIds(),
  )
  const [momentumSymbolKeys, setMomentumSymbolKeys] = useState<Set<string>>(
    () => loadMomentumSymbolKeys(),
  )
  const [momentumNoTpSymbolKeys, setMomentumNoTpSymbolKeys] = useState<Set<string>>(
    () => loadMomentumNoTpSymbolKeys(),
  )
  const [momentumLiveSymbolKeys, setMomentumLiveSymbolKeys] = useState<Set<string>>(
    () => loadMomentumLiveSymbolKeys(),
  )
  const [symbolOrders, setSymbolOrders] = useState<Record<string, string[]>>(() => {
    // Pre-load any saved orders when the component mounts (watchlists aren't loaded yet,
    // but we keep a partial map and fill it in after load)
    return {}
  })
  const [momentumTrades, setMomentumTrades] = useState<MomentumTrade[]>(
    () => loadMomentumTrades(),
  )
  const canvasScrollRef = useRef<HTMLDivElement | null>(null)
  const [bulkUploadOpen, setBulkUploadOpen] = useState(false)
  const [hiddenByWatchlist, setHiddenByWatchlist] = useState(() => loadAllHiddenSymbolTokens())

  /** Returns symbols for a watchlist — auto-sorted or manual drag order. */
  const orderedSymbolsFor = useCallback(
    (wl: Watchlist): WatchlistSymbol[] => {
      if (autoSortConfig.enabled) {
        const broker = (wl.broker || 'angel') as WatchlistBroker
        const accountEnv = wl.account_env || defaultAccountEnv(broker)
        return sortSymbolsByWindowChange(
          wl.symbols,
          broker,
          accountEnv,
          windowChanges,
          autoSortConfig.column,
        )
      }
      return applySymbolOrder(wl.symbols, symbolOrders[wl.id] ?? null)
    },
    [autoSortConfig, symbolOrders, windowChanges],
  )

  const visibleOrderedSymbolsFor = useCallback(
    (wl: Watchlist): WatchlistSymbol[] =>
      visibleWatchlistSymbols(orderedSymbolsFor(wl), wl.id, hiddenByWatchlist[wl.id]),
    [orderedSymbolsFor, hiddenByWatchlist],
  )

  /** Stable map of ordered symbols used by the momentum hook — only recomputes when watchlists or orders change. */
  const allOrderedSymbols = useMemo(
    () => Object.fromEntries(watchlists.map(wl => [wl.id, orderedSymbolsFor(wl)])),
    [watchlists, orderedSymbolsFor],
  )

  const syncMomentumState = useCallback(() => {
    setMomentumWatchlistIds(loadMomentumWatchlistIds())
    setMomentumSymbolKeys(loadMomentumSymbolKeys())
    setMomentumNoTpSymbolKeys(loadMomentumNoTpSymbolKeys())
    setMomentumLiveSymbolKeys(loadMomentumLiveSymbolKeys())
  }, [])

  const handleToggleMomentum = useCallback((watchlistId: string) => {
    setMomentumWatchlistIds(prev => toggleMomentumWatchlistId(prev, watchlistId))
    notifyMomentumStateChanged()
  }, [])

  const handleToggleSymbolMomentum = useCallback((watchlistId: string, symboltoken: string) => {
    const { normal, noTp } = setMomentumSymbolMode(
      momentumSymbolKeys, momentumNoTpSymbolKeys, watchlistId, symboltoken, 'normal',
    )
    setMomentumSymbolKeys(normal)
    setMomentumNoTpSymbolKeys(noTp)
    notifyMomentumStateChanged()
  }, [momentumSymbolKeys, momentumNoTpSymbolKeys])

  const handleToggleSymbolMomentumNoTp = useCallback((watchlistId: string, symboltoken: string) => {
    const { normal, noTp } = setMomentumSymbolMode(
      momentumSymbolKeys, momentumNoTpSymbolKeys, watchlistId, symboltoken, 'no-tp',
    )
    setMomentumSymbolKeys(normal)
    setMomentumNoTpSymbolKeys(noTp)
    notifyMomentumStateChanged()
  }, [momentumSymbolKeys, momentumNoTpSymbolKeys])

  const handleToggleSymbolMomentumLive = useCallback((watchlistId: string, symboltoken: string) => {
    setMomentumLiveSymbolKeys(prev => toggleMomentumLiveSymbolKey(prev, watchlistId, symboltoken))
    notifyMomentumStateChanged()
  }, [])

  const handleSymbolsReordered = useCallback((watchlistId: string, tokens: string[]) => {
    saveSymbolOrder(watchlistId, tokens)
    setSymbolOrders(prev => ({ ...prev, [watchlistId]: tokens }))
  }, [])

  const handleMetricsChange = useCallback((watchlistId: string, next: WatchlistCardMetrics) => {
    setCardMetrics(prev => {
      const current = prev[watchlistId]
      if (current?.symbolCount === next.symbolCount && current?.searchOpen === next.searchOpen) {
        return prev
      }
      return { ...prev, [watchlistId]: next }
    })
  }, [])

  const monitoredSymbols = useMemo(
    () => {
      const index = buildMomentumSymbolIndex(
        watchlists,
        momentumWatchlistIds,
        allOrderedSymbols,
        momentumSymbolKeys,
        momentumNoTpSymbolKeys,
        momentumLiveSymbolKeys,
      )
      return [...index.values()].map(symbol => ({
        symbol: symbol.tradingsymbol,
        tradeEnv: symbol.tradeEnv,
        noTakeProfit: symbol.noTakeProfit,
      }))
    },
    [
      watchlists,
      momentumWatchlistIds,
      allOrderedSymbols,
      momentumSymbolKeys,
      momentumNoTpSymbolKeys,
      momentumLiveSymbolKeys,
    ],
  )

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

  const syncLayoutsFromWatchlists = useCallback(
    (rows: Watchlist[]) => {
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
    },
    [persistLayouts],
  )

  useEffect(() => {
    if (!watchlistsReady) return
    syncLayoutsFromWatchlists(watchlists)
    setLoading(false)
  }, [watchlistsReady, watchlists, syncLayoutsFromWatchlists])

  useEffect(() => {
    const onMomentumChanged = () => syncMomentumState()
    const onMomentumTrade = () => {
      setMomentumTrades(loadMomentumTrades())
    }
    const onHiddenChanged = () => setHiddenByWatchlist(loadAllHiddenSymbolTokens())
    window.addEventListener(WL_MOMENTUM_CHANGED_EVENT, onMomentumChanged)
    window.addEventListener(WL_MOMENTUM_TRADE_EVENT, onMomentumTrade)
    window.addEventListener(WL_HIDDEN_SYMBOLS_CHANGED_EVENT, onHiddenChanged)
    return () => {
      window.removeEventListener(WL_MOMENTUM_CHANGED_EVENT, onMomentumChanged)
      window.removeEventListener(WL_MOMENTUM_TRADE_EVENT, onMomentumTrade)
      window.removeEventListener(WL_HIDDEN_SYMBOLS_CHANGED_EVENT, onHiddenChanged)
    }
  }, [syncMomentumState])

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

  /**
   * Creates a named watchlist, resolves each ticker through broker search, and
   * adds every match. Successful symbols stream into the list as they resolve;
   * unresolved tickers are surfaced in a toast (and in the dialog summary).
   */
  const handleBulkUpload: BulkUploadHandler = async ({ name, broker, tickers }, onProgress) => {
    const accountEnv = defaultAccountEnv(broker)
    const created = await createWatchlist(name, { broker, account_env: accountEnv })
    setWatchlists(prev => [...prev, created])
    persistLayouts({
      ...layouts,
      [created.id]: {
        ...layoutForNewWatchlist(layouts, cardMetrics, created.id),
        width: cardWidthForTable(visibleChangeColumns.length),
      },
    })

    const succeeded: string[] = []
    const failed: string[] = []
    for (let i = 0; i < tickers.length; i++) {
      const ticker = tickers[i]
      onProgress({ done: i, total: tickers.length, current: ticker })
      try {
        const results = await searchWatchlistSymbol(broker, ticker, accountEnv)
        const hit = pickWatchlistSymbolMatch(results, ticker)
        if (!hit) {
          failed.push(ticker)
          continue
        }
        const updated = await addWatchlistSymbol(created.id, {
          symboltoken: hit.symboltoken,
          tradingsymbol: hit.tradingsymbol,
          exchange: hit.exchange,
        })
        setWatchlists(prev => prev.map(wl => (wl.id === created.id ? updated : wl)))
        succeeded.push(ticker)
      } catch {
        failed.push(ticker)
      }
    }
    onProgress({ done: tickers.length, total: tickers.length, current: '' })

    showPlatformToast({
      variant: failed.length === 0 ? 'success' : succeeded.length > 0 ? 'warning' : 'error',
      title: `Bulk upload · ${name}`,
      message:
        failed.length === 0
          ? `${succeeded.length} symbol${succeeded.length === 1 ? '' : 's'} added`
          : `${succeeded.length} added · ${failed.length} failed: ${failed.join(', ')}`,
      duration: failed.length === 0 ? 5000 : 10000,
    })

    return { watchlistName: name, succeeded, failed }
  }

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
      const target = watchlists.find(wl => wl.id === watchlistId)
      if (!target) return

      const exists = target.symbols.some(symbol => symbol.symboltoken === hit.symboltoken)
      if (exists) {
        if (isWatchlistSymbolHidden(watchlistId, hit.symboltoken)) {
          unhideWatchlistSymbol(watchlistId, hit.symboltoken)
          showPlatformToast({
            variant: 'success',
            title: 'Symbol restored',
            message: `${hit.tradingsymbol} is visible again (feed kept active).`,
            duration: 4000,
          })
        }
        return
      }

      const updated = await addWatchlistSymbol(watchlistId, hit)
      setWatchlists(prev => prev.map(wl => (wl.id === watchlistId ? updated : wl)))
    })

  /** Hides from the UI only — the symbol stays subscribed on the watchlist feed. */
  const handleRemoveSymbol = (watchlistId: string, symboltoken: string) => {
    hideWatchlistSymbol(watchlistId, symboltoken)
  }

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

  /**
   * Re-packs every watchlist into a tidy masonry grid that fills the full canvas
   * width — no blank gutter on the right. Fits as many columns as possible at the
   * minimum table width, then stretches the column width so the row spans edge to
   * edge. Each card stacks under the currently-shortest column so heights stay
   * balanced and nothing overlaps.
   */
  const handleAutoArrange = useCallback(() => {
    if (watchlists.length === 0) return
    const minWidth = tableMinWidth
    const fallback = minWidth * 3 + GRID_GAP_X * 2 + GRID_ORIGIN_X * 2
    const clientWidth = canvasScrollRef.current?.clientWidth || fallback
    const available = Math.max(minWidth, clientWidth - GRID_ORIGIN_X * 2)

    const fit = Math.floor((available + GRID_GAP_X) / (minWidth + GRID_GAP_X))
    const columns = Math.max(1, Math.min(fit || 1, watchlists.length))
    const width = clampWidth(
      Math.max(minWidth, Math.floor((available - (columns - 1) * GRID_GAP_X) / columns)),
    )
    const columnHeights = new Array<number>(columns).fill(GRID_ORIGIN_Y)

    const next: WatchlistLayoutMap = {}
    for (const wl of watchlists) {
      const metrics = cardMetrics[wl.id] ?? { symbolCount: wl.symbols.length, searchOpen: false }
      const shortest = columnHeights.indexOf(Math.min(...columnHeights))
      const y = columnHeights[shortest]
      next[wl.id] = {
        x: GRID_ORIGIN_X + shortest * (width + GRID_GAP_X),
        y,
        width,
      }
      columnHeights[shortest] = y + cardHeightForContent(metrics.symbolCount, metrics.searchOpen) + GRID_GAP_Y
    }
    persistLayouts(next)
    canvasScrollRef.current?.scrollTo({ top: 0, left: 0, behavior: 'smooth' })
  }, [watchlists, cardMetrics, tableMinWidth, persistLayouts])

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
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="h-9 w-1 rounded-full bg-accent" aria-hidden="true" />
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="font-display text-xl font-bold tracking-tightest text-text-primary">Watchlists</h1>
              {hasSymbols && (
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] ${
                    connected
                      ? 'border-green/30 bg-green/10 text-green'
                      : 'border-accent/30 bg-accent/10 text-accent'
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-green' : 'bg-accent'}`} />
                  {connected ? 'Live' : 'Connecting…'}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-text-secondary">
              Cards grow with your symbols · drag to rearrange · resize on the right edge
              {hasSymbols && (
                <span className="ml-1.5 text-text-secondary/80">
                  {momentumConfig.enabled ? '· Momentum on' : ''}
                  {autoSortConfig.enabled ? ` · Auto-sort ${autoSortConfig.column}` : ''}
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <WatchlistMomentumSettings
            onChange={setMomentumConfig}
            monitoredSymbols={monitoredSymbols}
          />
          <WatchlistAutoSort config={autoSortConfig} onChange={setAutoSortConfig} />
          <WatchlistColumnPicker
            visibleColumns={visibleChangeColumns}
            onChange={handleVisibleChangeColumns}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleAutoArrange}
            disabled={busy || watchlists.length === 0}
            className="gap-1.5"
            title="Re-arrange watchlists into a tidy grid"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            Tidy grid
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setBulkUploadOpen(true)}
            disabled={busy}
            className="gap-1.5"
            title="Create a watchlist from a list of tickers"
          >
            <Upload className="h-3.5 w-3.5" />
            Bulk upload
          </Button>
          <Button type="button" size="sm" onClick={handleCreate} disabled={busy} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" />
            New watchlist
          </Button>
        </div>
      </div>

      <BulkUploadWatchlistDialog
        open={bulkUploadOpen}
        defaultName={`Watchlist ${watchlists.length + 1}`}
        onClose={() => setBulkUploadOpen(false)}
        onSubmit={handleBulkUpload}
      />

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

      {momentumTrades.length > 0 && (
        <div className="shrink-0 border-b border-accent/20 bg-accent/[0.05] px-5 py-3">
          <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="grid h-6 w-6 place-items-center rounded-md bg-accent/15 text-accent">
                <Zap className="h-3.5 w-3.5" />
              </span>
              <span className="font-display text-sm font-bold tracking-tightest text-text-primary">
                Momentum Trades
              </span>
              <span className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-accent">
                {momentumTrades.length} order{momentumTrades.length === 1 ? '' : 's'}
              </span>
              <span className="hidden text-[11px] text-text-secondary sm:inline">
                orders placed by momentum · symbols stay in their watchlist
              </span>
            </div>
            <Button
              type="button"
              size="xs"
              variant="tertiary"
              onClick={() => setMomentumTrades(clearMomentumTrades())}
              className="hover:text-red"
            >
              Clear all
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {momentumTrades.map(trade => (
              <div
                key={trade.id}
                className="group flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 shadow-panel transition-colors hover:border-accent/40"
              >
                <span
                  className={`grid h-7 w-10 shrink-0 place-items-center rounded-md text-[10px] font-bold uppercase tracking-wide ${
                    trade.accountEnv === 'live'
                      ? 'border border-red/30 bg-red/15 text-red'
                      : 'border border-green/30 bg-green/15 text-green'
                  }`}
                >
                  {trade.accountEnv === 'live' ? 'LIVE' : 'DEMO'}
                </span>
                <div className="flex min-w-0 flex-col">
                  <span className="font-display text-[13px] font-bold leading-tight tracking-tightest text-text-primary">
                    {trade.tradingsymbol}
                    <span className="ml-1.5 font-mono text-[10px] font-medium text-text-secondary">
                      {trade.noTakeProfit ? 'no TP · 1% SL' : '5% TP · 1% SL'}
                    </span>
                  </span>
                  <span className="truncate font-mono text-[10px] leading-tight text-text-secondary tabular-nums">
                    @ {trade.entryPrice.toFixed(2)} · {trade.executionId} · {new Date(trade.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <button
                  type="button"
                  title="Remove from list"
                  onClick={() => setMomentumTrades(removeMomentumTrade(trade.id))}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-text-secondary/60 transition-colors hover:bg-card-hi hover:text-red"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div ref={canvasScrollRef} className="relative min-h-0 flex-1 overflow-auto bg-primary/30">
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
                    orderedSymbols={visibleOrderedSymbolsFor(wl)}
                    hiddenSymbolTokens={hiddenByWatchlist[wl.id]}
                    autoSortEnabled={autoSortConfig.enabled}
                    ticks={ticks}
                    windowChanges={windowChanges}
                    visibleChangeColumns={visibleChangeColumns}
                    isMomentumWatchlist={momentumWatchlistIds.has(wl.id)}
                    onToggleMomentum={handleToggleMomentum}
                    momentumSymbolKeys={momentumSymbolKeys}
                    onToggleSymbolMomentum={handleToggleSymbolMomentum}
                    momentumNoTpSymbolKeys={momentumNoTpSymbolKeys}
                    onToggleSymbolMomentumNoTp={handleToggleSymbolMomentumNoTp}
                    momentumLiveSymbolKeys={momentumLiveSymbolKeys}
                    onToggleSymbolMomentumLive={handleToggleSymbolMomentumLive}
                    onRename={handleRename}
                    onDelete={handleDelete}
                    onBrokerChange={handleBrokerChange}
                    onDeployAll={handleDeployAll}
                    onAddSymbol={handleAddSymbol}
                    onRemoveSymbol={handleRemoveSymbol}
                    onSymbolsReordered={handleSymbolsReordered}
                    onMetricsChange={handleMetricsChange}
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
