import {
  percentChangeFromHistory,
  priceAtOrBefore,
  type PriceSample,
  type WatchlistChangeWindowId,
} from './watchlistChangeColumns'

export const WATCHLIST_MOMENTUM_STORAGE_KEY = 'watchlist-momentum-v3'

export type MomentumConfig = {
  // toggles
  enabled: boolean
  autoDemo: boolean
  /** Simple = just min 1m change. Complex = all velocity/acceleration/guard filters. */
  complexMode: boolean

  // velocity / window filters
  min30sPct: number       // minimum 30s change (burst check)
  min1mPct: number        // minimum 1m change
  min5mPct: number        // minimum 5m change
  min10mPct: number       // minimum 10m change (trend confirmation)
  require10mPositive: boolean  // reject if 10m is negative (bounce guard)

  // spike / overextended guards
  maxSpike1mPct: number   // reject 1m > this (data outlier / blow-off top guard)
  max10mPct: number       // reject if 10m already > this (move played out)

  // acceleration
  accelerationFactor: number  // 1m rate must exceed (5m_avg * factor)
  require5mAbove10mRate: boolean  // 5m per-minute rate > 10m per-minute rate

  // price filter
  minLtp: number          // ignore symbols below this price (0 = off)
  maxLtp: number          // ignore symbols above this price (0 = off)

  // timing
  cooldownMs: number      // per-symbol cooldown between alerts
  scanEveryMs: number     // how often to scan (ms)

  // strategy parameters
  longPercent: number
  shortPercent: number
  initialThreshold: number
  maxCapital: number
}

export const DEFAULT_MOMENTUM_CONFIG: MomentumConfig = {
  enabled: true,
  autoDemo: true,
  complexMode: false,

  min30sPct: 0.35,
  min1mPct: 0.75,
  min5mPct: 1.0,
  min10mPct: 0.3,
  require10mPositive: false,

  maxSpike1mPct: 12,
  max10mPct: 8,

  accelerationFactor: 1.3,
  require5mAbove10mRate: false,

  minLtp: 0,
  maxLtp: 0,

  cooldownMs: 15 * 60_000,
  scanEveryMs: 2000,

  longPercent: 5,
  shortPercent: 1,
  initialThreshold: 0.2,
  maxCapital: 100_000,
}

export type MomentumSignal = {
  score: number
  headline: string
  detail: string
}

export function loadMomentumConfig(): MomentumConfig {
  try {
    const raw = localStorage.getItem(WATCHLIST_MOMENTUM_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_MOMENTUM_CONFIG }
    const parsed = JSON.parse(raw) as Partial<MomentumConfig>
    return { ...DEFAULT_MOMENTUM_CONFIG, ...parsed }
  } catch {
    return { ...DEFAULT_MOMENTUM_CONFIG }
  }
}

export function saveMomentumConfig(config: MomentumConfig): void {
  localStorage.setItem(WATCHLIST_MOMENTUM_STORAGE_KEY, JSON.stringify(config))
}

export function shortTermVelocityPct(samples: PriceSample[], now = Date.now()): number | null {
  if (samples.length < 2) return null
  const current = samples[samples.length - 1]?.ltp
  const past = priceAtOrBefore(samples, now - 30_000)
  if (current == null || past == null || past <= 0) return null
  return Math.round(((current - past) / past) * 10000) / 100
}

export type MomentumFilterReason =
  | 'no_history'
  | 'price_filter'
  | 'direction_down'
  | 'spike_guard'
  | 'min_1m'
  | 'min_5m'
  | 'min_10m'
  | 'require_10m_positive'
  | 'max_10m_played_out'
  | 'acceleration'
  | 'rate_not_above_10m'
  | 'no_burst_or_strong_1m'

export type MomentumFilterReject =
  | 'no_history'
  | 'price_filter'
  | 'direction_down'
  | 'spike_guard'
  | 'min_1m'
  | 'min_5m'
  | 'min_10m'
  | 'require_10m_positive'
  | 'max_10m_played_out'
  | 'acceleration'
  | 'rate_not_above_10m'
  | 'no_burst_or_strong_1m'

export function explainMomentumFilters(
  changes: Partial<Record<WatchlistChangeWindowId, number | null>>,
  samples: PriceSample[],
  options: {
    tickDirection?: 'up' | 'down' | 'flat'
    currentLtp?: number
    config?: MomentumConfig
    now?: number
  } = {},
): { pass: boolean; reasons: string[] } {
  const config = options.config ?? DEFAULT_MOMENTUM_CONFIG
  const now = options.now ?? Date.now()
  const c1 = changes['1m']
  const c5 = changes['5m']
  const c10 = changes['10m'] ?? null
  const v30 = shortTermVelocityPct(samples, now)
  const ltp = options.currentLtp
  const reasons: string[] = []

  const fmt = (v: number | null | undefined) =>
    v == null ? 'null' : `${v > 0 ? '+' : ''}${v.toFixed(3)}%`

  reasons.push(`1m=${fmt(c1)} 5m=${fmt(c5)} 10m=${fmt(c10)} 30s=${fmt(v30)} ltp=${ltp ?? '?'} dir=${options.tickDirection ?? '?'}`)

  if (c1 == null || c5 == null || samples.length < 2) {
    reasons.push('✗ no_history: 1m or 5m null, or < 2 samples')
    return { pass: false, reasons }
  }
  if (ltp != null) {
    if (config.minLtp > 0 && ltp < config.minLtp) {
      reasons.push(`✗ price_filter: ltp ${ltp} < minLtp ${config.minLtp}`)
      return { pass: false, reasons }
    }
    if (config.maxLtp > 0 && ltp > config.maxLtp) {
      reasons.push(`✗ price_filter: ltp ${ltp} > maxLtp ${config.maxLtp}`)
      return { pass: false, reasons }
    }
  }
  if (options.tickDirection === 'down') {
    reasons.push('✗ direction_down')
    return { pass: false, reasons }
  }
  if (config.maxSpike1mPct > 0 && c1 > config.maxSpike1mPct) {
    reasons.push(`✗ spike_guard: 1m ${fmt(c1)} > maxSpike ${config.maxSpike1mPct}%`)
    return { pass: false, reasons }
  }
  if (c1 <= 0 || c1 < config.min1mPct) {
    reasons.push(`✗ min_1m: ${fmt(c1)} < min ${config.min1mPct}%`)
    return { pass: false, reasons }
  }
  if (c5 <= 0 || c5 < config.min5mPct) {
    reasons.push(`✗ min_5m: ${fmt(c5)} < min ${config.min5mPct}%`)
    return { pass: false, reasons }
  }
  if (c10 != null) {
    if (c10 < config.min10mPct) {
      reasons.push(`✗ min_10m: ${fmt(c10)} < min ${config.min10mPct}%`)
      return { pass: false, reasons }
    }
    if (config.require10mPositive && c10 <= 0) {
      reasons.push(`✗ require_10m_positive: ${fmt(c10)} <= 0`)
      return { pass: false, reasons }
    }
    if (config.max10mPct > 0 && c10 > config.max10mPct) {
      reasons.push(`✗ max_10m_played_out: ${fmt(c10)} > max ${config.max10mPct}%`)
      return { pass: false, reasons }
    }
  }
  const r1 = c1
  const r5 = c5 / 5
  if (r1 < r5 * config.accelerationFactor) {
    reasons.push(`✗ acceleration: 1m_rate ${fmt(r1)} < (5m_rate ${fmt(r5)} × ${config.accelerationFactor}) = ${fmt(r5 * config.accelerationFactor)}`)
    return { pass: false, reasons }
  }
  if (config.require5mAbove10mRate && c10 != null && c10 > 0) {
    const r10 = c10 / 10
    if (r5 < r10) {
      reasons.push(`✗ rate_not_above_10m: 5m_rate ${fmt(r5)} < 10m_rate ${fmt(r10)}`)
      return { pass: false, reasons }
    }
  }
  const hasBurst = v30 != null && v30 >= config.min30sPct
  const isStrong1m = c1 >= config.min1mPct * 1.5
  if (!hasBurst && !isStrong1m) {
    reasons.push(`✗ no_burst_or_strong_1m: 30s=${fmt(v30)} (need >=${config.min30sPct}%), 1m=${fmt(c1)} (need >=${(config.min1mPct * 1.5).toFixed(2)}% for strong)`)
    return { pass: false, reasons }
  }
  reasons.push(`✓ PASS — score=${((c1 * 2) + c5 + (v30 ?? 0) + (c10 ?? 0) * 0.5).toFixed(2)}`)
  return { pass: true, reasons }
}

export function detectRapidPositiveMomentum(
  changes: Partial<Record<WatchlistChangeWindowId, number | null>>,
  samples: PriceSample[],
  options: {
    tickDirection?: 'up' | 'down' | 'flat'
    currentLtp?: number
    config?: MomentumConfig
    now?: number
  } = {},
): MomentumSignal | null {
  const config = options.config ?? DEFAULT_MOMENTUM_CONFIG
  const now = options.now ?? Date.now()
  const change1m = changes['1m']
  const change5m = changes['5m']
  const change10m = changes['10m'] ?? null
  const velocity30s = shortTermVelocityPct(samples, now)

  if (change1m == null) return null

  // ════════════════════════════════════════════════════════════════════════
  // SIMPLE MODE — only the 1m threshold matters
  // ════════════════════════════════════════════════════════════════════════
  if (!config.complexMode) {
    if (change1m <= 0 || change1m < config.min1mPct) return null
    const score = change1m
    const detail = [
      change5m != null ? `5m ${change5m > 0 ? '+' : ''}${change5m.toFixed(2)}%` : null,
      velocity30s != null ? `30s ${velocity30s > 0 ? '+' : ''}${velocity30s.toFixed(2)}%` : null,
    ].filter(Boolean).join(' · ')
    return { score, headline: `+${change1m.toFixed(2)}% in 1m`, detail }
  }

  // ════════════════════════════════════════════════════════════════════════
  // COMPLEX MODE — full filter chain
  // ════════════════════════════════════════════════════════════════════════
  if (samples.length < 2) return null
  if (change5m == null) return null

  // ── price filter ────────────────────────────────────────────────────────
  const ltp = options.currentLtp
  if (ltp != null) {
    if (config.minLtp > 0 && ltp < config.minLtp) return null
    if (config.maxLtp > 0 && ltp > config.maxLtp) return null
  }

  // ── direction guard ──────────────────────────────────────────────────────
  if (options.tickDirection === 'down') return null

  // ── spike guard (outlier / blow-off top) ─────────────────────────────────
  if (config.maxSpike1mPct > 0 && change1m > config.maxSpike1mPct) return null

  // ── minimum thresholds ───────────────────────────────────────────────────
  if (change1m <= 0 || change1m < config.min1mPct) return null
  if (change5m <= 0 || change5m < config.min5mPct) return null

  // ── 10m filters ─────────────────────────────────────────────────────────
  if (change10m != null) {
    if (change10m < config.min10mPct) return null
    if (config.require10mPositive && change10m <= 0) return null
    if (config.max10mPct > 0 && change10m > config.max10mPct) return null
  }

  // ── acceleration: 1m rate vs 5m average per-minute ──────────────────────
  const rate1m = change1m
  const rate5mPerMin = change5m / 5
  if (rate1m < rate5mPerMin * config.accelerationFactor) return null

  // ── optional: 5m rate must also outpace 10m rate ────────────────────────
  if (config.require5mAbove10mRate && change10m != null && change10m > 0) {
    const rate10mPerMin = change10m / 10
    if (rate5mPerMin < rate10mPerMin) return null
  }

  // ── burst / strength check ───────────────────────────────────────────────
  const hasBurst = velocity30s != null && velocity30s >= config.min30sPct
  const isStrong1m = change1m >= config.min1mPct * 1.5
  if (!hasBurst && !isStrong1m) return null

  // ── score & labels ───────────────────────────────────────────────────────
  const score = change1m * 2 + change5m + (velocity30s ?? 0) + (change10m ?? 0) * 0.5
  const headline = `+${change1m.toFixed(2)}% in 1m`
  const detail = [
    `5m ${change5m > 0 ? '+' : ''}${change5m.toFixed(2)}%`,
    change10m != null ? `10m ${change10m > 0 ? '+' : ''}${change10m.toFixed(2)}%` : null,
    velocity30s != null ? `30s ${velocity30s > 0 ? '+' : ''}${velocity30s.toFixed(2)}%` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return { score, headline, detail }
}

export function momentumCooldownKey(tickKey: string, kind: 'alert' | 'demo'): string {
  return `${tickKey}:${kind}`
}

export function isCooldownActive(
  lastFired: Record<string, number>,
  key: string,
  cooldownMs: number,
  now = Date.now(),
): boolean {
  const prev = lastFired[key]
  return prev != null && now - prev < cooldownMs
}

export function formatMomentumToastMessage(
  tradingsymbol: string,
  signal: MomentumSignal,
  broker: string,
): string {
  return `${tradingsymbol} (${broker}) · ${signal.headline} · ${signal.detail}`
}

/** Recompute 30s change without adding a visible watchlist column. */
export function change30sFromSamples(samples: PriceSample[], currentLtp: number, now = Date.now()): number | null {
  return percentChangeFromHistory(samples, currentLtp, 30_000, now)
}
