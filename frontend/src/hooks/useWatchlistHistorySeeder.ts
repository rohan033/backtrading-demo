/**
 * On page load, pre-seeds the local price-history store with recent 1-minute candles
 * fetched from the backend. This makes 1m/2m/5m/10m/30m percentage changes available
 * immediately instead of waiting for the WebSocket feed to accumulate enough data.
 *
 * Only eToro symbols are seeded (backend returns an empty list for other brokers).
 * Each tick key is seeded at most once per browser session to avoid 429s on reload
 * or watchlist reshuffles.
 */

import { useEffect, useRef, type RefObject } from 'react'

import { MAX_WATCHLIST_HISTORY_MS, type PriceSample } from '../lib/watchlistChangeColumns'
import { isWatchlistHistorySeederEnabled } from '../lib/watchlistHistorySeederGate'
import { defaultAccountEnv } from '../lib/watchlistBrokers'
import { loadActivePanelId } from '../lib/watchlistPanels'
import { isTickKeySeeded, markTickKeySeeded } from '../lib/watchlistSeededKeys'
import { watchlistTickKey, type Watchlist } from '../lib/watchlists'

const MAX_CONCURRENT = 2
/** Request ~4.5 hours of 1-minute bars (270 candles). Enough for all windows. */
const CANDLE_COUNT = 270

type SeedCandle = { time: number; close: number }

async function fetchSeedCandles(
  broker: string,
  accountEnv: string,
  symbol: string,
  token: string,
): Promise<SeedCandle[]> {
  const url =
    `/api/watchlist/candles` +
    `?broker=${encodeURIComponent(broker)}` +
    `&account_env=${encodeURIComponent(accountEnv)}` +
    `&symbol=${encodeURIComponent(symbol)}` +
    `&token=${encodeURIComponent(token)}` +
    `&count=${CANDLE_COUNT}`
  const res = await fetch(url)
  if (!res.ok) return []
  const json = await res.json() as { data?: SeedCandle[] }
  return Array.isArray(json.data) ? json.data : []
}

/** Merge historical candle samples with any live samples already in the ref. */
function mergeSeedSamples(
  historicalSamples: PriceSample[],
  liveSamples: PriceSample[],
): PriceSample[] {
  const map = new Map<number, PriceSample>()
  for (const sample of historicalSamples) map.set(sample.ts, sample)
  for (const sample of liveSamples) map.set(sample.ts, sample)
  const now = Date.now()
  const cutoff = now - MAX_WATCHLIST_HISTORY_MS
  return Array.from(map.values())
    .filter(sample => sample.ts >= cutoff)
    .sort((a, b) => a.ts - b.ts)
}

export function useWatchlistHistorySeeder(
  watchlists: Watchlist[],
  historyRef: RefObject<Record<string, PriceSample[]>>,
  onSeeded?: () => void,
) {
  const inFlightRef = useRef<Set<string>>(new Set())
  const onSeededRef = useRef(onSeeded)
  useEffect(() => { onSeededRef.current = onSeeded }, [onSeeded])

  useEffect(() => {
    if (!watchlists.length || !isWatchlistHistorySeederEnabled()) return

    type SymbolJob = {
      broker: string
      accountEnv: string
      symbol: string
      token: string
      tickKey: string
    }

    const activePanelId = loadActivePanelId()
    const jobs: SymbolJob[] = []
    for (const watchlist of watchlists) {
      if (activePanelId && watchlist.panel_id && watchlist.panel_id !== activePanelId) {
        continue
      }

      const broker = (watchlist.broker || 'angel').toLowerCase()
      const accountEnv = watchlist.account_env || defaultAccountEnv(broker as 'etoro' | 'angel')
      for (const sym of watchlist.symbols) {
        const tickKey = watchlistTickKey(broker, accountEnv, sym.symboltoken)
        if (isTickKeySeeded(tickKey) || inFlightRef.current.has(tickKey)) continue
        jobs.push({
          broker,
          accountEnv,
          symbol: sym.tradingsymbol,
          token: sym.symboltoken,
          tickKey,
        })
      }
    }

    if (!jobs.length) return

    let cursor = 0
    let cancelled = false

    const worker = async () => {
      while (!cancelled && cursor < jobs.length) {
        const job = jobs[cursor++]
        if (isTickKeySeeded(job.tickKey) || inFlightRef.current.has(job.tickKey)) continue
        inFlightRef.current.add(job.tickKey)

        try {
          const candles = await fetchSeedCandles(
            job.broker,
            job.accountEnv,
            job.symbol,
            job.token,
          )
          markTickKeySeeded(job.tickKey)
          if (!candles.length) continue

          const historicalSamples: PriceSample[] = candles.map(candle => ({
            ts: candle.time * 1000,
            ltp: candle.close,
          }))

          if (historyRef.current) {
            const existing = historyRef.current[job.tickKey] ?? []
            historyRef.current[job.tickKey] = mergeSeedSamples(historicalSamples, existing)
          }
          onSeededRef.current?.()
        } catch {
          // Live ticks will backfill over time.
        } finally {
          inFlightRef.current.delete(job.tickKey)
        }
      }
    }

    void Promise.all(Array.from({ length: MAX_CONCURRENT }, () => worker()))

    return () => {
      cancelled = true
    }
  }, [watchlists, historyRef])
}
