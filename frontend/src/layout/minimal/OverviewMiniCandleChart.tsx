import { useMemo } from 'react'

import { formatHomeMoverPrice } from '../../lib/homeMarketMovers'
import { aggregateCandlesToMinutes } from '../../lib/overviewHaltDirection'
import {
  buildMiniChartVolumeRows,
  formatCompactVolume,
} from '../../lib/overviewMiniChartVolume'
import type { WatchlistSanitizedCandle } from '../../lib/watchlistCandles'

const CHART_W = 68
const CHART_H = 30
const CANDLE_COUNT = 3

const PASTEL_UP = '#7dcea0'
const PASTEL_UP_WICK = '#52b788'
const PASTEL_DOWN = '#f5a8a8'
const PASTEL_DOWN_WICK = '#e57373'
const CHART_BG = '#e8ecef'

function compactPrice(price: number): string {
  if (!Number.isFinite(price)) return ''
  if (Math.abs(price) >= 100) return price.toFixed(1)
  if (Math.abs(price) >= 1) return price.toFixed(2)
  return price.toFixed(3)
}

function formatSpotPrice(price: number | null | undefined): string | null {
  if (price == null || !Number.isFinite(price)) return null
  return formatHomeMoverPrice(price)
}

export default function OverviewMiniCandleChart({
  candles,
  liveLtp = null,
}: {
  candles: WatchlistSanitizedCandle[]
  liveLtp?: number | null
}) {
  const allBars = useMemo(() => aggregateCandlesToMinutes(candles, 5), [candles])
  const bars = useMemo(() => allBars.slice(-CANDLE_COUNT), [allBars])
  const priorBars = useMemo(
    () => allBars.slice(0, -CANDLE_COUNT).slice(-12),
    [allBars],
  )
  const volumeRows = useMemo(
    () => buildMiniChartVolumeRows(bars, priorBars),
    [bars, priorBars],
  )

  const lastClose = bars.length ? bars[bars.length - 1].close : null
  const isLive = liveLtp != null && Number.isFinite(liveLtp)
  const spotPrice = isLive ? liveLtp : lastClose
  const spotLabel = formatSpotPrice(spotPrice)

  if (!bars.length) {
    if (!spotLabel) return null
    return (
      <div className="ov-mini-chart-row">
        <div className="ov-mini-chart-box ov-mini-chart-box--empty" aria-hidden />
        <span className="ov-mini-chart__spot">{spotLabel}</span>
      </div>
    )
  }

  const lows = bars.map(c => c.low)
  const highs = bars.map(c => c.high)
  const min = Math.min(...lows)
  const max = Math.max(...highs)
  const range = max - min || Math.max(max * 0.01, 0.0001)
  const slot = CHART_W / bars.length

  return (
    <div className="ov-mini-chart-row">
      <div className="ov-mini-chart-box">
        <svg
          className="ov-mini-chart"
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          width={CHART_W}
          height={CHART_H}
          aria-hidden
        >
          <rect x={0} y={0} width={CHART_W} height={CHART_H} fill={CHART_BG} rx={3} />
          {bars.map((candle, index) => {
            const bullish = candle.close >= candle.open
            const fill = bullish ? PASTEL_UP : PASTEL_DOWN
            const wick = bullish ? PASTEL_UP_WICK : PASTEL_DOWN_WICK
            const x = index * slot + slot * 0.16
            const bodyW = slot * 0.68

            const y = (price: number) =>
              CHART_H - 3 - ((price - min) / range) * (CHART_H - 6)

            const yHigh = y(candle.high)
            const yLow = y(candle.low)
            const yOpen = y(candle.open)
            const yClose = y(candle.close)
            const bodyTop = Math.min(yOpen, yClose)
            const bodyH = Math.max(1.2, Math.abs(yClose - yOpen))
            const cx = x + bodyW / 2

            return (
              <g key={candle.time}>
                <line x1={cx} y1={yHigh} x2={cx} y2={yLow} stroke={wick} strokeWidth={1} />
                <rect x={x} y={bodyTop} width={bodyW} height={bodyH} fill={fill} rx={0.5} />
              </g>
            )
          })}
        </svg>
        <div className="ov-mini-chart__closes">
          {bars.map((candle, index) => {
            const volumeRow = volumeRows[index]
            const bullish = volumeRow?.bullish ?? candle.close >= candle.open
            const surge = volumeRow?.surge ?? null
            const volume = volumeRow?.volume ?? candle.volume
            const fillPct = volumeRow?.fillPct ?? 0
            const surgeLabel = surge === 'positive'
              ? 'Volume surge (bullish)'
              : surge === 'negative'
                ? 'Volume surge (bearish)'
                : ''
            const title = [
              compactPrice(candle.close) ? `Close ${compactPrice(candle.close)}` : '',
              volume > 0 ? `Vol ${formatCompactVolume(volume)}` : '',
              surgeLabel,
            ].filter(Boolean).join(' · ')

            return (
              <div key={candle.time} className="ov-mini-chart__col" title={title || undefined}>
                {compactPrice(candle.close) ? (
                  <span className="ov-mini-chart__close">{compactPrice(candle.close)}</span>
                ) : null}
                {volume > 0 ? (
                  <>
                    <div className="ov-mini-chart__vol">
                      <div
                        className={`ov-mini-chart__vol-fill ov-mini-chart__vol-fill--${bullish ? 'up' : 'down'}`}
                        style={{ width: `${Math.max(0, Math.min(100, fillPct))}%` }}
                      />
                    </div>
                    {surge ? (
                      <span
                        className={`ov-mini-chart__vol-surge ov-mini-chart__vol-surge--${surge}`}
                        aria-label={surgeLabel}
                      >
                        {surge === 'positive' ? '▲' : '▼'}
                      </span>
                    ) : null}
                  </>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
      {spotLabel ? (
        <span className={`ov-mini-chart__spot${isLive ? ' ov-mini-chart__spot--live' : ''}`}>
          {spotLabel}
        </span>
      ) : null}
    </div>
  )
}
