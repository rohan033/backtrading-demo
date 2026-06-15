import { useMemo, useRef, useState } from 'react'
import { CandlestickChart, ChevronsUp, LayoutGrid, LineChart, Search, X } from 'lucide-react'

import { Button } from '../ui/button'
import type { WatchlistChangeWindowId } from '../../lib/watchlistChangeColumns'
import type { PriceSample } from '../../lib/watchlistChangeColumns'
import type { WatchlistWindowChanges } from '../../hooks/useWatchlistPriceHistory'
import type { WatchlistChartSymbol } from '../../lib/watchlistUniqueSymbols'
import type { WatchlistSanitizedCandle } from '../../lib/watchlistCandles'
import type { WatchlistChartRenderMode } from '../../lib/watchlistViewMode'
import type { WatchlistTick } from '../../lib/watchlists'
import WatchlistSymbolChart from './WatchlistSymbolChart'

type Props = {
  symbols: WatchlistChartSymbol[]
  ticks: Record<string, WatchlistTick>
  samplesByKey: Record<string, PriceSample[]>
  candlesByKey: Record<string, WatchlistSanitizedCandle[]>
  focusedTickKey: string | null
  onFocusChange: (tickKey: string | null) => void
  visibleChangeColumns: WatchlistChangeWindowId[]
  windowChanges: WatchlistWindowChanges
  chartRenderMode: WatchlistChartRenderMode
  onChartRenderModeChange: (mode: WatchlistChartRenderMode) => void
  momentumSymbolKeys: Set<string>
  momentumNoTpSymbolKeys: Set<string>
  momentumLiveSymbolKeys: Set<string>
  onToggleSymbolMomentum: (watchlistId: string, symboltoken: string) => void
  onToggleSymbolMomentumNoTp: (watchlistId: string, symboltoken: string) => void
  onToggleSymbolMomentumLive: (watchlistId: string, symboltoken: string) => void
  onHideChrome?: () => void
}

const GRID_CHART_HEIGHT = 200
const SIDEBAR_CHART_HEIGHT = 132

function matchesChartSearch(symbol: WatchlistChartSymbol, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const haystack = [
    symbol.tradingsymbol,
    symbol.symboltoken,
    symbol.exchange,
    symbol.broker,
    symbol.accountEnv,
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(q)
}

function ChartSearchInput({
  value,
  onChange,
  total,
  matched,
  compact = false,
  onSubmit,
}: {
  value: string
  onChange: (value: string) => void
  total: number
  matched: number
  compact?: boolean
  onSubmit?: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const filtering = value.trim().length > 0

  return (
    <div className={`relative min-w-0 ${compact ? 'w-full' : 'w-full max-w-xs sm:max-w-sm'}`}>
      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-secondary/70" />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            onChange('')
            inputRef.current?.blur()
          }
          if (event.key === 'Enter') {
            onSubmit?.()
          }
        }}
        placeholder="Filter symbols…"
        className={`w-full rounded-md border border-border bg-card py-1.5 pl-7 pr-16 text-[11px] text-text-primary outline-none transition-colors placeholder:text-text-secondary/60 focus:border-accent/50 ${
          compact ? 'py-1' : ''
        }`}
        aria-label="Filter chart symbols"
      />
      <div className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
        {filtering ? (
          <span className="text-[10px] tabular-nums text-text-secondary">
            {matched}/{total}
          </span>
        ) : null}
        {value ? (
          <button
            type="button"
            onClick={() => {
              onChange('')
              inputRef.current?.focus()
            }}
            className="pointer-events-auto rounded p-0.5 text-text-secondary hover:bg-card-hi hover:text-text-primary"
            title="Clear filter"
          >
            <X className="h-3 w-3" />
          </button>
        ) : null}
      </div>
    </div>
  )
}

function ChromeHideButton({ onHide }: { onHide?: () => void }) {
  if (!onHide) return null
  return (
    <button
      type="button"
      onClick={onHide}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-text-secondary transition-colors hover:bg-card hover:text-text-primary"
      title="Hide header, panels, and top feed"
    >
      <ChevronsUp className="h-3.5 w-3.5" />
    </button>
  )
}

function ChartRenderToggle({
  mode,
  onChange,
}: {
  mode: WatchlistChartRenderMode
  onChange: (mode: WatchlistChartRenderMode) => void
}) {
  return (
    <div
      className="inline-flex overflow-hidden rounded-md border border-border bg-card"
      title="Line or candlestick chart"
    >
      <button
        type="button"
        onClick={() => onChange('line')}
        className={`inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium transition-colors ${
          mode === 'line' ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:text-text-primary'
        }`}
      >
        <LineChart className="h-3 w-3" />
        Line
      </button>
      <button
        type="button"
        onClick={() => onChange('candle')}
        className={`inline-flex items-center gap-1 border-l border-border px-2 py-1 text-[10px] font-medium transition-colors ${
          mode === 'candle' ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:text-text-primary'
        }`}
      >
        <CandlestickChart className="h-3 w-3" />
        Candle
      </button>
    </div>
  )
}

function chartProps(
  symbol: WatchlistChartSymbol,
  ticks: Record<string, WatchlistTick>,
  samplesByKey: Record<string, PriceSample[]>,
  candlesByKey: Record<string, WatchlistSanitizedCandle[]>,
  shared: Omit<Props, 'symbols' | 'ticks' | 'samplesByKey' | 'candlesByKey' | 'focusedTickKey' | 'onFocusChange'>,
) {
  return {
    watchlistId: symbol.watchlistId,
    tickKey: symbol.tickKey,
    symboltoken: symbol.symboltoken,
    label: symbol.tradingsymbol,
    broker: symbol.broker,
    samples: samplesByKey[symbol.tickKey] ?? [],
    candles: candlesByKey[symbol.tickKey] ?? [],
    tick: ticks[symbol.tickKey],
    renderMode: shared.chartRenderMode,
    visibleChangeColumns: shared.visibleChangeColumns,
    windowChanges: shared.windowChanges,
    momentumSymbolKeys: shared.momentumSymbolKeys,
    momentumNoTpSymbolKeys: shared.momentumNoTpSymbolKeys,
    momentumLiveSymbolKeys: shared.momentumLiveSymbolKeys,
    onToggleSymbolMomentum: shared.onToggleSymbolMomentum,
    onToggleSymbolMomentumNoTp: shared.onToggleSymbolMomentumNoTp,
    onToggleSymbolMomentumLive: shared.onToggleSymbolMomentumLive,
  }
}

export default function WatchlistChartView({
  symbols,
  ticks,
  samplesByKey,
  focusedTickKey,
  onFocusChange,
  candlesByKey,
  onHideChrome,
  ...shared
}: Props) {
  const [searchQuery, setSearchQuery] = useState('')

  const filteredSymbols = useMemo(
    () => symbols.filter(symbol => matchesChartSearch(symbol, searchQuery)),
    [symbols, searchQuery],
  )

  const focused = useMemo(
    () => symbols.find(symbol => symbol.tickKey === focusedTickKey) ?? null,
    [symbols, focusedTickKey],
  )

  const sidebarSymbols = useMemo(() => {
    if (!focused) return []
    return filteredSymbols.filter(symbol => symbol.tickKey !== focused.tickKey)
  }, [filteredSymbols, focused])

  const focusSingleSearchMatch = () => {
    if (filteredSymbols.length !== 1) return
    onFocusChange(filteredSymbols[0].tickKey)
  }

  if (symbols.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-text-secondary">
        No symbols to chart in this panel.
      </div>
    )
  }

  if (focused) {
    return (
      <div className="flex h-full min-h-0 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-primary/30">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2">
            <div className="min-w-0">
              <div className="truncate font-display text-sm font-bold text-text-primary">
                {focused.tradingsymbol}
              </div>
              <div className="text-[10px] text-text-secondary">
                {focused.broker.toUpperCase()} · {focused.accountEnv}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <ChartRenderToggle
                mode={shared.chartRenderMode}
                onChange={shared.onChartRenderModeChange}
              />
              <ChromeHideButton onHide={onHideChrome} />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onFocusChange(null)}
                className="gap-1.5"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                Grid view
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden p-3">
            <WatchlistSymbolChart
              {...chartProps(focused, ticks, samplesByKey, candlesByKey, shared)}
              fillParent
              highlighted
            />
          </div>
        </div>

        <aside className="flex w-56 shrink-0 flex-col border-l border-border bg-secondary/20">
          <div className="flex shrink-0 flex-col gap-2 border-b border-border px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                Symbols
              </span>
              <button
                type="button"
                onClick={() => onFocusChange(null)}
                className="rounded p-0.5 text-text-secondary hover:bg-card hover:text-text-primary"
                title="Close focus"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <ChartSearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              total={symbols.length}
              matched={filteredSymbols.length}
              compact
              onSubmit={focusSingleSearchMatch}
            />
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
            {sidebarSymbols.length ? (
              sidebarSymbols.map(symbol => (
                <WatchlistSymbolChart
                  key={symbol.tickKey}
                  {...chartProps(symbol, ticks, samplesByKey, candlesByKey, shared)}
                  height={SIDEBAR_CHART_HEIGHT}
                  compact
                  onSelect={() => onFocusChange(symbol.tickKey)}
                />
              ))
            ) : (
              <p className="px-1 py-2 text-[10px] text-text-secondary">
                {searchQuery.trim()
                  ? `No symbols match “${searchQuery.trim()}”.`
                  : 'No other symbols in this panel.'}
              </p>
            )}
          </div>
        </aside>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-primary/30">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <ChartSearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          total={symbols.length}
          matched={filteredSymbols.length}
          onSubmit={focusSingleSearchMatch}
        />
        <div className="flex shrink-0 items-center gap-2">
          <ChartRenderToggle
            mode={shared.chartRenderMode}
            onChange={shared.onChartRenderModeChange}
          />
          <ChromeHideButton onHide={onHideChrome} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {filteredSymbols.length ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {filteredSymbols.map(symbol => (
              <WatchlistSymbolChart
                key={symbol.tickKey}
                {...chartProps(symbol, ticks, samplesByKey, candlesByKey, shared)}
                height={GRID_CHART_HEIGHT}
                compact
                showMaximize
                onMaximize={() => onFocusChange(symbol.tickKey)}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <p className="text-sm text-text-secondary">
              No symbols match “{searchQuery.trim()}”.
            </p>
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="text-[11px] font-medium text-accent hover:underline"
            >
              Clear filter
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
