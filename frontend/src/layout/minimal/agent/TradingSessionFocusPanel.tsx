import { useMemo, useRef, useState } from 'react'

import SessionDetailChart from '@/components/charts/SessionDetailChart'
import SymbolLogo from '@/components/SymbolLogo'
import type { A2uiStockPick } from '@/lib/agentA2uiCatalog'
import { formatBrokerMoney } from '@/lib/currency'
import { defaultAccountEnv, type WatchlistBroker } from '@/lib/watchlistBrokers'
import {
  computeWindowChanges,
  formatWindowChangePct,
  WATCHLIST_CHANGE_WINDOWS,
} from '@/lib/watchlistChangeColumns'
import { useCandidateChartLive } from '@/hooks/useCandidateChartLive'

import '../WatchAndTrade.css'

type Props = {
  picks?: A2uiStockPick[] | null
  selectedSymbol: string | null
  onPickSymbol: (symbol: string) => void
  broker: string
  accountEnv: string
  fallbackPick?: A2uiStockPick | null
}

function pickSymbolMatch(pick: A2uiStockPick, symbol: string): boolean {
  const target = symbol.toUpperCase()
  const root = pick.symbol.toUpperCase().split('-')[0]
  return pick.symbol.toUpperCase() === target || root === target.split('-')[0]
}

function SessionChangeStrip({
  changes,
  compact = true,
}: {
  changes: Record<string, number | null | undefined>
  compact?: boolean
}) {
  const windows = WATCHLIST_CHANGE_WINDOWS.filter(window =>
    ['1m', '2m', '5m', '10m', '30m', '4h'].includes(window.id),
  )
  return (
    <div className={`wt-change-strip${compact ? ' wt-change-strip--compact' : ''}`}>
      {windows.map(window => {
        const value = changes[window.id]
        const direction = value == null || Number.isNaN(value) ? '' : value >= 0 ? 'wt-up' : 'wt-down'
        const cls = direction ? `wt-change-mini ${direction}` : 'wt-change-mini'
        return (
          <div key={window.id} className={`wt-change-mini-card ${direction}`}>
            <span className="wt-change-mini-label">{window.label}</span>
            <span className={cls}>{formatWindowChangePct(value)}</span>
          </div>
        )
      })}
    </div>
  )
}

export default function TradingSessionFocusPanel({
  picks,
  selectedSymbol,
  onPickSymbol,
  broker,
  accountEnv,
  fallbackPick,
}: Props) {
  const [chartHeight, setChartHeight] = useState(240)
  const chartResizingRef = useRef(false)

  const feedBroker = (broker || 'etoro') as WatchlistBroker
  const feedEnv = (accountEnv || defaultAccountEnv(feedBroker)) as 'live' | 'demo'

  const activePick = useMemo(() => {
    if (!selectedSymbol && !fallbackPick?.symbol) return null
    const sym = selectedSymbol || fallbackPick?.symbol || ''
    const fromList = picks?.find(pick => pickSymbolMatch(pick, sym))
    if (fromList) return fromList
    return fallbackPick ?? null
  }, [fallbackPick, picks, selectedSymbol])

  const live = useCandidateChartLive({
    symbol: activePick?.symbol || '',
    token: activePick?.token,
    exchange: activePick?.exchange,
    broker: feedBroker,
    accountEnv: feedEnv,
    enabled: Boolean(activePick?.symbol),
  })

  const changes = useMemo(() => {
    if (live.ltp == null) return {}
    return computeWindowChanges(live.samples, live.ltp)
  }, [live.ltp, live.samples])

  const ticker = activePick?.symbol.split('-')[0] || '—'
  const dayChange = changes['4h'] ?? changes['30m'] ?? changes['10m'] ?? null
  const priceLabel = live.ltp != null ? formatBrokerMoney(feedBroker, live.ltp) : '—'
  const changeLabel = formatWindowChangePct(dayChange)
  const changeUp = (dayChange ?? 0) >= 0

  const handleChartResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    chartResizingRef.current = true
    const startY = e.clientY
    const startH = chartHeight
    const onMove = (ev: MouseEvent) => {
      if (!chartResizingRef.current) return
      setChartHeight(Math.max(60, Math.min(400, startH + (ev.clientY - startY))))
    }
    const onUp = () => {
      chartResizingRef.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const logoVisual = activePick ? {
    ticker,
    logo35x35: activePick.logoUrl ?? null,
    logo50x50: activePick.logoUrl ?? null,
    logo150x150: activePick.logoUrl ?? null,
  } : null

  return (
    <div className="wt-detail-wrap am-ts-wt-detail">
      {!activePick && !picks?.length ? (
        <div className="wt-detail wt-detail--empty">
          <span className="wt-detail-hint">Select a stock</span>
        </div>
      ) : (
        <div className="wt-detail">
          {(picks?.length ?? 0) > 1 ? (
            <div className="wt-session-picks" role="tablist" aria-label="Candidate picks">
              {picks!.map(pick => {
                const sym = pick.symbol.split('-')[0]
                const active = pickSymbolMatch(pick, selectedSymbol || '')
                return (
                  <button
                    key={pick.symbol}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={`wt-session-pick${active ? ' wt-session-pick--active' : ''}`}
                    onClick={() => onPickSymbol(pick.symbol)}
                  >
                    {sym}
                  </button>
                )
              })}
            </div>
          ) : null}

          {activePick ? (
            <>
              <div className="wt-detail-top-row">
                <div className="wt-detail-price-card">
                  <div className="wt-detail-head-row">
                    <div className="wt-detail-title-row">
                      <div className="wt-detail-logo-inline">
                        <SymbolLogo
                          symbol={ticker}
                          visual={logoVisual}
                          size="large"
                          classPrefix="wt"
                        />
                      </div>
                      <div className="wt-detail-title-copy">
                        <div className="wt-detail-ticker">{ticker}</div>
                        <div className="wt-detail-fullname">{activePick.name || ticker}</div>
                        <div className="wt-detail-price">{priceLabel}</div>
                        <div className={`wt-detail-change ${changeUp ? 'wt-up' : 'wt-down'}`}>{changeLabel}</div>
                      </div>
                    </div>
                    <SessionChangeStrip changes={changes} compact />
                  </div>
                  {activePick.recommendation ? (
                    <p className="wt-session-thesis">{activePick.recommendation}</p>
                  ) : null}
                </div>
              </div>

              <div className="wt-detail-chart-box" style={{ height: chartHeight }}>
                <SessionDetailChart
                  symbol={activePick.symbol}
                  token={activePick.token}
                  exchange={activePick.exchange}
                  broker={feedBroker}
                  accountEnv={feedEnv}
                  height={chartHeight}
                />
                <div
                  className="wt-chart-resize-handle"
                  onMouseDown={handleChartResizeStart}
                  title="Drag to resize chart"
                />
              </div>
            </>
          ) : (
            <div className="wt-detail-hint">Select a candidate above</div>
          )}
        </div>
      )}
    </div>
  )
}
