import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import HaltedSymbolDot from '../../components/tradeHalts/HaltedSymbolDot'
import { useTradeHalts } from '../../context/TradeHaltsContext'
import { useWatchlistStream } from '../../context/WatchlistStreamContext'
import { useOverviewCandleCache, defaultOverviewAccountEnv } from '../../hooks/useOverviewCandleCache'
import { useOverviewScreeners } from '../../hooks/useOverviewScreeners'
import { useSecondTicker } from '../../hooks/useSecondTicker'
import {
  formatHomeMoverAbs,
  formatHomeMoverPct,
  formatHomeMoverPrice,
  homeMoverMetrics,
  homeMoverHeroLabel,
  homeMoverPctTone,
  sortHomeMoverRows,
} from '../../lib/homeMarketMovers'
import { classifyHaltDirection } from '../../lib/overviewHaltDirection'
import { buildOverviewTradeSignals, collectTopScreenerPicks, type OverviewTradeSignal } from '../../lib/overviewSignals'
import { reorderScreeners } from '../../lib/screenerApi'
import { tickerSymbol, yahooFinanceUrl } from '../../lib/screenerDefinition'
import type { Screener, ScreenerResultRow } from '../../lib/screenerApi'
import { currentlyHaltedHalts } from '../../lib/tradeHaltsUi'
import { formatWindowChangePct, windowChangeTone } from '../../lib/watchlistChangeColumns'
import { resolveWatchlistTickKey } from '../../lib/watchlistFeedReuse'
import { useUrlState } from './useUrlState'
import OverviewMiniCandleChart from './OverviewMiniCandleChart'
import './HomeMarketMoversPanel.css'
import './Overview.css'

const TOP_ROWS = 10

type ScreenerDragSrc = { col: 0 | 1; idx: number }
type ScreenerDropTgt = { col: 0 | 1; idx: number | 'end'; pos?: 'before' | 'after' }

function splitScreenersToColumns(screeners: Screener[]): [Screener[], Screener[]] {
  const left: Screener[] = []
  const right: Screener[] = []
  screeners.forEach((screener, index) => {
    if (index % 2 === 0) left.push(screener)
    else right.push(screener)
  })
  return [left, right]
}

function flattenScreenerColumns(cols: [Screener[], Screener[]]): string[] {
  const ids: string[] = []
  const maxLen = Math.max(cols[0].length, cols[1].length)
  for (let i = 0; i < maxLen; i++) {
    if (cols[0][i]) ids.push(cols[0][i].id)
    if (cols[1][i]) ids.push(cols[1][i].id)
  }
  return ids
}

function OverviewCandlesToggle({
  active,
  onToggle,
  compact,
}: {
  active: boolean
  onToggle: (event: React.MouseEvent<HTMLButtonElement>) => void
  compact?: boolean
}) {
  return (
    <button
      type="button"
      className={`ov-candles-toggle${active ? ' ov-candles-toggle--active' : ''}${compact ? ' ov-candles-toggle--compact' : ''}`}
      aria-pressed={active}
      title="5m candles on this screener. ⌘-click for all screeners."
      onClick={onToggle}
    >
      5m
    </button>
  )
}

function screenerShowsCandles(
  screenerId: string,
  screenerCandlesOn: ReadonlySet<string>,
): boolean {
  return screenerCandlesOn.has(screenerId)
}

type LiveQuote = {
  ltp: number | null
  change1m: number | null
  change5m: number | null
  flash: 'up' | 'down' | null
}

function screenerTopRows(screener: Screener): ScreenerResultRow[] {
  return sortHomeMoverRows([...(screener.results || [])], screener.source_type).slice(0, TOP_ROWS)
}

function OverviewMoverCard({
  row,
  screener,
  live,
  haltFor,
  showCandles,
  candles,
}: {
  row: ScreenerResultRow
  screener: Screener
  live?: LiveQuote
  haltFor: (symbol: string) => import('../../lib/tradeHalts').TradeHalt | null | undefined
  showCandles: boolean
  candles: import('../../lib/watchlistCandles').WatchlistSanitizedCandle[]
}) {
  const symbol = tickerSymbol(row.ticker).toUpperCase()
  const metrics = homeMoverMetrics(row, screener.source_type)
  const tone = homeMoverPctTone(metrics.pct)
  const heroLabel = homeMoverHeroLabel(row, screener.source_type)
  const price = live?.ltp ?? metrics.price
  const flashClass = live?.flash === 'up'
    ? ' ov-mover-card--flash-up'
    : live?.flash === 'down'
      ? ' ov-mover-card--flash-down'
      : ''
  const yahooUrl = yahooFinanceUrl(row.ticker)

  return (
    <article className={`hm-mover-card ov-mover-card${flashClass}`}>
      <header className="hm-mover-card__head">
        {yahooUrl ? (
          <a
            className="hm-mover-card__symbol"
            href={yahooUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={`Open ${symbol} on Yahoo Finance`}
          >
            {symbol}
          </a>
        ) : (
          <span className="hm-mover-card__symbol">{symbol}</span>
        )}
        <HaltedSymbolDot halt={haltFor(symbol)} />
      </header>
      <div className="hm-mover-card__body">
        <div className="ov-mover-card__hero">
          <div className={`hm-mover-card__pct hm-mover-card__pct--${tone}`}>
            {formatHomeMoverPct(metrics.pct)}
          </div>
          <span className="ov-mover-card__hero-label">{heroLabel}</span>
        </div>
        <div className="hm-mover-card__meta">
          <span className={`hm-mover-card__price ov-mover-card__price${flashClass}`}>
            {formatHomeMoverPrice(price)}
          </span>
          <span className={`hm-mover-card__abs hm-mover-card__abs--${tone}`}>
            {formatHomeMoverAbs(metrics.changeAbs)}
          </span>
        </div>
        {(live?.change1m != null || live?.change5m != null) ? (
          <div className="ov-mover-card__windows">
            {live?.change1m != null ? (
              <span className={`ov-mover-card__win ov-mover-card__win--${windowChangeTone(live.change1m)}`}>
                1m {formatWindowChangePct(live.change1m)}
              </span>
            ) : null}
            {live?.change5m != null ? (
              <span className={`ov-mover-card__win ov-mover-card__win--${windowChangeTone(live.change5m)}`}>
                5m {formatWindowChangePct(live.change5m)}
              </span>
            ) : null}
          </div>
        ) : null}
        {showCandles ? (
          <OverviewMiniCandleChart candles={candles} liveLtp={live?.ltp ?? null} />
        ) : null}
      </div>
    </article>
  )
}

function OverviewScreenerBlock({
  screener,
  liveBySymbol,
  haltFor,
  candlesBySymbol,
  showCandles,
  onToggleCandles,
  refreshPct,
  refreshing,
  isDragging,
  dropPos,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  screener: Screener
  liveBySymbol: Record<string, LiveQuote>
  haltFor: (symbol: string) => import('../../lib/tradeHalts').TradeHalt | null | undefined
  candlesBySymbol: Record<string, import('../../lib/watchlistCandles').WatchlistSanitizedCandle[]>
  showCandles: boolean
  onToggleCandles: (event: React.MouseEvent<HTMLButtonElement>) => void
  refreshPct: number
  refreshing: boolean
  isDragging: boolean
  dropPos: 'before' | 'after' | null
  onDragStart: () => void
  onDragOver: (event: React.DragEvent) => void
  onDrop: (event: React.DragEvent) => void
  onDragEnd: () => void
}) {
  const rows = screenerTopRows(screener)

  return (
    <section
      className={[
        'ov-screener',
        isDragging ? 'ov-screener--dragging' : '',
        dropPos === 'before' ? 'ov-screener--drop-before' : '',
        dropPos === 'after' ? 'ov-screener--drop-after' : '',
      ].join(' ')}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <header className="ov-screener__head">
        <span className="ov-screener__drag" aria-hidden title="Drag to reorder">
          ⠿
        </span>
        <h3 className="ov-screener__title">{screener.name}</h3>
        <div
          className={`ov-screener__refresh-pill${refreshing ? ' ov-screener__refresh-pill--refreshing' : ''}`}
          role="progressbar"
          aria-valuenow={Math.round(refreshPct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${screener.name} refresh`}
          title={refreshing ? 'Refreshing…' : 'Until next screener refresh'}
        >
          <div
            className="ov-screener__refresh-pill-fill"
            style={{ width: `${Math.max(0, Math.min(100, refreshPct))}%` }}
          />
        </div>
        <OverviewCandlesToggle active={showCandles} onToggle={onToggleCandles} compact />
      </header>
      {rows.length ? (
        <div className="ov-screener__grid">
          {rows.map(row => {
            const symbol = tickerSymbol(row.ticker).toUpperCase()
            return (
              <OverviewMoverCard
                key={row.id || `${screener.id}-${symbol}`}
                row={row}
                screener={screener}
                live={liveBySymbol[symbol]}
                haltFor={haltFor}
                showCandles={showCandles}
                candles={candlesBySymbol[symbol] || []}
              />
            )
          })}
        </div>
      ) : null}
    </section>
  )
}

function OverviewScreenerColumn({
  colIdx,
  screeners,
  dragSrc,
  dropTgt,
  onColDragOver,
  onColDrop,
  onDragStart,
  onCardDragOver,
  onCardDrop,
  onDragEnd,
  liveBySymbol,
  haltFor,
  candlesBySymbol,
  screenerCandlesOn,
  toggleScreenerCandles,
  refreshProgress,
  refreshingIds,
}: {
  colIdx: 0 | 1
  screeners: Screener[]
  dragSrc: ScreenerDragSrc | null
  dropTgt: ScreenerDropTgt | null
  onColDragOver: (event: React.DragEvent, col: 0 | 1) => void
  onColDrop: (event: React.DragEvent) => void
  onDragStart: (col: 0 | 1, idx: number) => void
  onCardDragOver: (event: React.DragEvent, col: 0 | 1, idx: number) => void
  onCardDrop: (event: React.DragEvent) => void
  onDragEnd: () => void
  liveBySymbol: Record<string, LiveQuote>
  haltFor: (symbol: string) => import('../../lib/tradeHalts').TradeHalt | null | undefined
  candlesBySymbol: Record<string, import('../../lib/watchlistCandles').WatchlistSanitizedCandle[]>
  screenerCandlesOn: ReadonlySet<string>
  toggleScreenerCandles: (screenerId: string, metaKey: boolean) => void
  refreshProgress: Record<string, number>
  refreshingIds: ReadonlySet<string>
}) {
  return (
    <div
      className="ov-screener-column"
      onDragOver={event => onColDragOver(event, colIdx)}
      onDrop={onColDrop}
    >
      {screeners.map((screener, idx) => {
        const isDragging = dragSrc?.col === colIdx && dragSrc.idx === idx
        const isTarget = dropTgt && typeof dropTgt.idx === 'number' && dropTgt.col === colIdx && dropTgt.idx === idx
        const dropPos = isTarget ? (dropTgt?.pos ?? null) : null
        return (
          <OverviewScreenerBlock
            key={screener.id}
            screener={screener}
            liveBySymbol={liveBySymbol}
            haltFor={haltFor}
            candlesBySymbol={candlesBySymbol}
            showCandles={screenerShowsCandles(screener.id, screenerCandlesOn)}
            onToggleCandles={event => toggleScreenerCandles(screener.id, event.metaKey)}
            refreshPct={refreshProgress[screener.id] ?? 100}
            refreshing={refreshingIds.has(screener.id)}
            isDragging={isDragging}
            dropPos={dropPos}
            onDragStart={() => onDragStart(colIdx, idx)}
            onDragOver={event => onCardDragOver(event, colIdx, idx)}
            onDrop={onCardDrop}
            onDragEnd={onDragEnd}
          />
        )
      })}
      {dropTgt?.col === colIdx && dropTgt.idx === 'end' ? (
        <div className="ov-screener-column__end-indicator" aria-hidden />
      ) : null}
    </div>
  )
}

function HaltDirectionBadge({ direction }: { direction: string }) {
  if (direction === 'uphalt') {
    return <span className="ov-halt-badge ov-halt-badge--up">↑ Uphalt</span>
  }
  if (direction === 'downhalt') {
    return <span className="ov-halt-badge ov-halt-badge--down">↓ Downhalt</span>
  }
  if (direction === 'flat') {
    return <span className="ov-halt-badge ov-halt-badge--flat">→ Flat</span>
  }
  return <span className="ov-halt-badge ov-halt-badge--unknown">?</span>
}

function OverviewSignalCard({
  signal,
  candles,
  liveLtp,
}: {
  signal: OverviewTradeSignal
  candles: import('../../lib/watchlistCandles').WatchlistSanitizedCandle[]
  liveLtp?: number | null
}) {
  const pctLabel = signal.screenerName
    ? `${signal.screenerName} chg`
    : signal.haltDirection === 'uphalt'
      ? 'Pre-halt momentum'
      : 'Screener chg'
  const tooltip = signal.reasons.join('\n')

  return (
    <article
      className={`ov-signal-card ov-signal-card--${signal.urgency}`}
      title={tooltip || undefined}
    >
      <div className="ov-signal-card__head">
        <strong className="ov-signal-card__symbol">{signal.symbol}</strong>
        <span className="ov-signal-card__score">{signal.score}</span>
      </div>
      {signal.changePct != null ? (
        <div className="ov-signal-card__metric">
          <span className="ov-signal-card__pct">{formatHomeMoverPct(signal.changePct)}</span>
          <span className="ov-signal-card__pct-label">{pctLabel}</span>
        </div>
      ) : null}
      <OverviewMiniCandleChart candles={candles} liveLtp={liveLtp} />
    </article>
  )
}

function OverviewHaltCard({
  symbol,
  reasonCode,
  reason,
  direction,
}: {
  symbol: string
  reasonCode?: string | null
  reason: string
  direction: string
}) {
  return (
    <article className={`ov-halt-card ov-halt-card--${direction}`}>
      <div className="ov-halt-card__head">
        <strong>{symbol}</strong>
        <HaltDirectionBadge direction={direction} />
      </div>
      <div className="ov-halt-card__meta">
        <span>{reasonCode || 'HALT'}</span>
        <span>{reason}</span>
      </div>
    </article>
  )
}

export default function Overview() {
  const { state } = useUrlState()
  const accountEnv = useMemo((): 'live' | 'demo' => {
    const env = (state.home_env || '').trim().toLowerCase()
    return env === 'live' || env === 'demo' ? env : defaultOverviewAccountEnv()
  }, [state.home_env])

  const { screeners, error, refreshProgress, refreshingIds, applyScreenerOrder } = useOverviewScreeners(true)
  const { halts, haltFor } = useTradeHalts()
  const { watchlists, ticks, windowChanges } = useWatchlistStream()
  const now = useSecondTicker()
  const prevLtpRef = useRef<Record<string, number>>({})

  const [screenerCandlesOn, setScreenerCandlesOn] = useState<Set<string>>(() => new Set())
  const [screenerCols, setScreenerCols] = useState<[Screener[], Screener[]]>([[], []])
  const [dragSrc, setDragSrc] = useState<ScreenerDragSrc | null>(null)
  const [dropTgt, setDropTgt] = useState<ScreenerDropTgt | null>(null)
  const skipColsSyncRef = useRef(false)

  const screenersOrderKey = useMemo(
    () => screeners.map(item => item.id).join('|'),
    [screeners],
  )

  useEffect(() => {
    if (skipColsSyncRef.current) return
    setScreenerCols(splitScreenersToColumns(screeners))
  }, [screenersOrderKey, screeners])

  const persistScreenerOrder = useCallback(async (cols: [Screener[], Screener[]]) => {
    const ids = flattenScreenerColumns(cols)
    skipColsSyncRef.current = true
    setScreenerCols(cols)
    try {
      await reorderScreeners(ids)
      applyScreenerOrder(ids)
    } catch {
      setScreenerCols(splitScreenersToColumns(screeners))
    } finally {
      skipColsSyncRef.current = false
    }
  }, [applyScreenerOrder, screeners])

  const handleScreenerDragStart = (col: 0 | 1, idx: number) => {
    setDragSrc({ col, idx })
  }

  const handleScreenerCardDragOver = (event: React.DragEvent, col: 0 | 1, idx: number) => {
    event.preventDefault()
    event.stopPropagation()
    if (!dragSrc) return
    if (dragSrc.col === col && dragSrc.idx === idx) return
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const pos: 'before' | 'after' = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    setDropTgt({ col, idx, pos })
  }

  const handleScreenerColDragOver = (event: React.DragEvent, col: 0 | 1) => {
    event.preventDefault()
    setDropTgt({ col, idx: 'end' })
  }

  const handleScreenerDrop = (event: React.DragEvent) => {
    event.stopPropagation()
    if (!dragSrc || !dropTgt) {
      setDragSrc(null)
      setDropTgt(null)
      return
    }

    const cols: [Screener[], Screener[]] = [[...screenerCols[0]], [...screenerCols[1]]]
    const [moved] = cols[dragSrc.col].splice(dragSrc.idx, 1)
    if (!moved) {
      setDragSrc(null)
      setDropTgt(null)
      return
    }

    if (dropTgt.idx === 'end') {
      cols[dropTgt.col].push(moved)
    } else {
      let insertAt = dropTgt.pos === 'after' ? dropTgt.idx + 1 : dropTgt.idx
      if (dragSrc.col === dropTgt.col && dragSrc.idx < insertAt) insertAt--
      cols[dropTgt.col].splice(Math.max(0, insertAt), 0, moved)
    }

    setDragSrc(null)
    setDropTgt(null)
    void persistScreenerOrder(cols)
  }

  const handleScreenerDragEnd = () => {
    setDragSrc(null)
    setDropTgt(null)
  }

  const toggleScreenerCandles = (screenerId: string, metaKey: boolean) => {
    if (metaKey) {
      const willEnable = !screenerCandlesOn.has(screenerId)
      setScreenerCandlesOn(
        willEnable ? new Set(screeners.map(screener => screener.id)) : new Set(),
      )
      return
    }
    setScreenerCandlesOn(prev => {
      const next = new Set(prev)
      if (next.has(screenerId)) next.delete(screenerId)
      else next.add(screenerId)
      return next
    })
  }

  const halted = useMemo(() => currentlyHaltedHalts(halts), [halts])

  const candleSymbols = useMemo(() => {
    const symbols = new Set<string>()
    for (const halt of halted) symbols.add(halt.symbol.toUpperCase())
    for (const pick of collectTopScreenerPicks(screeners)) {
      symbols.add(pick.symbol)
    }
    for (const screener of screeners) {
      if (!screenerShowsCandles(screener.id, screenerCandlesOn)) continue
      for (const row of screenerTopRows(screener)) {
        symbols.add(tickerSymbol(row.ticker).toUpperCase())
      }
    }
    return [...symbols]
  }, [halted, screeners, screenerCandlesOn])

  const candlesFetchEnabled = candleSymbols.length > 0
  const { candlesBySymbol } = useOverviewCandleCache(candleSymbols, accountEnv, candlesFetchEnabled)

  const haltedAnalysis = useMemo(() => {
    return halted.map(halt => {
      const symbol = halt.symbol.toUpperCase()
      const candles = candlesBySymbol[symbol] || []
      const threshold = halt.pause_threshold_price != null
        ? Number(halt.pause_threshold_price)
        : null
      const analysis = classifyHaltDirection(candles, {
        pauseThreshold: Number.isFinite(threshold) ? threshold : null,
      })
      return { halt, symbol, ...analysis }
    })
  }, [halted, candlesBySymbol])

  const tradeSignals = useMemo(() => buildOverviewTradeSignals({
    screeners,
    haltedSymbols: haltedAnalysis.map(item => ({
      symbol: item.symbol,
      direction: item.direction,
      changePct: item.changePct,
    })),
    candlesBySymbol,
  }), [screeners, haltedAnalysis, candlesBySymbol])

  const liveBySymbol = useMemo(() => {
    const map: Record<string, LiveQuote> = {}
    const allSymbols = new Set<string>()
    for (const screener of screeners) {
      for (const row of screenerTopRows(screener)) {
        allSymbols.add(tickerSymbol(row.ticker).toUpperCase())
      }
    }
    for (const signal of tradeSignals) {
      allSymbols.add(signal.symbol.toUpperCase())
    }

    for (const symbol of allSymbols) {
      const tickKey = resolveWatchlistTickKey(watchlists, {
        broker: 'etoro',
        account_env: accountEnv,
        symbol,
      })
      const tick = tickKey ? ticks[tickKey] : undefined
      const ltp = tick?.ltp ?? null
      const change1m = tickKey ? windowChanges[tickKey]?.['1m'] ?? null : null
      const change5m = tickKey ? windowChanges[tickKey]?.['5m'] ?? null : null

      let flash: LiveQuote['flash'] = null
      if (ltp != null && tickKey) {
        const prev = prevLtpRef.current[symbol]
        if (prev != null && ltp !== prev) {
          flash = ltp > prev ? 'up' : 'down'
        }
        prevLtpRef.current[symbol] = ltp
      }

      map[symbol] = { ltp, change1m, change5m, flash }
    }
    return map
  }, [screeners, tradeSignals, watchlists, ticks, windowChanges, accountEnv, now])

  return (
    <div className="ov-page">
      <div className="ov-grid">
        <div className="ov-main">
          {error ? <div className="ov-error" role="alert">{error}</div> : null}

          <div className="ov-screener-columns">
            <OverviewScreenerColumn
              colIdx={0}
              screeners={screenerCols[0]}
              dragSrc={dragSrc}
              dropTgt={dropTgt}
              onColDragOver={handleScreenerColDragOver}
              onColDrop={handleScreenerDrop}
              onDragStart={handleScreenerDragStart}
              onCardDragOver={handleScreenerCardDragOver}
              onCardDrop={handleScreenerDrop}
              onDragEnd={handleScreenerDragEnd}
              liveBySymbol={liveBySymbol}
              haltFor={haltFor}
              candlesBySymbol={candlesBySymbol}
              screenerCandlesOn={screenerCandlesOn}
              toggleScreenerCandles={toggleScreenerCandles}
              refreshProgress={refreshProgress}
              refreshingIds={refreshingIds}
            />
            <OverviewScreenerColumn
              colIdx={1}
              screeners={screenerCols[1]}
              dragSrc={dragSrc}
              dropTgt={dropTgt}
              onColDragOver={handleScreenerColDragOver}
              onColDrop={handleScreenerDrop}
              onDragStart={handleScreenerDragStart}
              onCardDragOver={handleScreenerCardDragOver}
              onCardDrop={handleScreenerDrop}
              onDragEnd={handleScreenerDragEnd}
              liveBySymbol={liveBySymbol}
              haltFor={haltFor}
              candlesBySymbol={candlesBySymbol}
              screenerCandlesOn={screenerCandlesOn}
              toggleScreenerCandles={toggleScreenerCandles}
              refreshProgress={refreshProgress}
              refreshingIds={refreshingIds}
            />
          </div>
        </div>

        <aside className="ov-sidebar">
          <section className="ov-panel ov-panel--halts">
            <header className="ov-panel__head">
              <h2 className="ov-panel__title">Halts</h2>
              {halted.length ? (
                <span className="ov-panel__count">{halted.length}</span>
              ) : null}
            </header>
            <div className="ov-panel__body">
              {halted.length ? (
                <div className="ov-halt-grid">
                  {haltedAnalysis.map(item => (
                    <OverviewHaltCard
                      key={item.halt.id}
                      symbol={item.symbol}
                      reasonCode={item.halt.reason_code}
                      reason={item.reason}
                      direction={item.direction}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </section>

          <section className="ov-panel ov-panel--signals">
            <header className="ov-panel__head">
              <h2 className="ov-panel__title">Suggestions</h2>
              {tradeSignals.length ? (
                <span className="ov-panel__count">{tradeSignals.length}</span>
              ) : null}
            </header>
            <div className="ov-panel__body">
              {tradeSignals.length ? (
                <div className="ov-signal-grid">
                  {tradeSignals.map(signal => (
                    <OverviewSignalCard
                      key={signal.symbol}
                      signal={signal}
                      candles={candlesBySymbol[signal.symbol] || []}
                      liveLtp={liveBySymbol[signal.symbol]?.ltp ?? null}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}
