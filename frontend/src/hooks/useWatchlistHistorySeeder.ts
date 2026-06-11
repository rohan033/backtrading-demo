/**
 * On page load, pre-seeds the local price-history store with recent 1-minute candles
 * fetched from the backend. This makes 1m/2m/5m/10m/30m percentage changes available
 * immediately instead of waiting for the WebSocket feed to accumulate enough data.
 *
 * Only eToro symbols are seeded (backend returns an empty list for other brokers).
 * Concurrency is capped at MAX_CONCURRENT to avoid hammering the eToro rate limiter.
 */

import { useEffect, useRef, type RefObject } from 'react'

import { MAX_WATCHLIST_HISTORY_MS, type PriceSample } from '../lib/watchlistChangeColumns'
import { defaultAccountEnv } from '../lib/watchlistBrokers'
import { watchlistTickKey, type Watchlist } from '../lib/watchlists'

const MAX_CONCURRENT = 3
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

/** Merge historical candle samples with any live samples already in the ref.
 *  Live samples (more recent) always win on timestamp collision.
 *  Trims to MAX_WATCHLIST_HISTORY_MS. */
function mergeSeedSamples(
  historicalSamples: PriceSample[],
  liveSamples: PriceSample[],
): PriceSample[] {
  const map = new Map<number, PriceSample>()
  // Historical first — live samples will overwrite on collision
  for (const s of historicalSamples) map.set(s.ts, s)
  for (const s of liveSamples) map.set(s.ts, s)
  const now = Date.now()
  const cutoff = now - MAX_WATCHLIST_HISTORY_MS
  return Array.from(map.values())
    .filter(s => s.ts >= cutoff)
    .sort((a, b) => a.ts - b.ts)
}

export function useWatchlistHistorySeeder(
  watchlists: Watchlist[],
  historyRef: RefObject<Record<string, PriceSample[]>>,
  /** Called after any batch of symbols is seeded so window changes recompute immediately. */
  onSeeded?: () => void,
) {
  const seededRef = useRef<Set<string>>(new Set())
  const onSeededRef = useRef(onSeeded)
  useEffect(() => { onSeededRef.current = onSeeded }, [onSeeded])

  useEffect(() => {
    if (!watchlists.length) return

    type SymbolJob = {
      broker: string
      accountEnv: string
      symbol: string
      token: string
      tickKey: string
    }

    const jobs: SymbolJob[] = []
    for (const wl of watchlists) {
      const broker = (wl.broker || 'angel').toLowerCase()
      const accountEnv = wl.account_env || defaultAccountEnv(broker as 'etoro' | 'angel')
      for (const sym of wl.symbols) {
        const tickKey = watchlistTickKey(broker, accountEnv, sym.symboltoken)
        if (seededRef.current.has(tickKey)) continue
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

    const worker = async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor++]
        if (seededRef.current.has(job.tickKey)) continue
        seededRef.current.add(job.tickKey)

        try {
          const candles = await fetchSeedCandles(
            job.broker,
            job.accountEnv,
            job.symbol,
            job.token,
          )
          if (!candles.length) continue

          const historicalSamples: PriceSample[] = candles.map(c => ({
            ts: c.time * 1000, // Unix seconds → ms
            ltp: c.close,
          }))

          if (historyRef.current) {
            const existing = historyRef.current[job.tickKey] ?? []
            historyRef.current[job.tickKey] = mergeSeedSamples(historicalSamples, existing)
          }
          onSeededRef.current?.()
        } catch {
          // Ignore individual failures — live ticks will backfill over time
        }
      }
    }

    // Fan out MAX_CONCURRENT workers
    void Promise.all(Array.from({ length: MAX_CONCURRENT }, () => worker()))
  }, [watchlists, historyRef])
}
