export const CHART_SCAN_LOOKBACK_KEY = 'home-chart-scan-lookback-minutes'

export const CHART_SCAN_LOOKBACK_OPTIONS = [
  { minutes: 1, label: '1m' },
  { minutes: 2, label: '2m' },
  { minutes: 5, label: '5m' },
  { minutes: 10, label: '10m' },
  { minutes: 15, label: '15m' },
  { minutes: 30, label: '30m' },
  { minutes: 60, label: '1h' },
] as const

export type ChartScanLookbackMinutes = (typeof CHART_SCAN_LOOKBACK_OPTIONS)[number]['minutes']

export const DEFAULT_CHART_SCAN_LOOKBACK_MINUTES: ChartScanLookbackMinutes = 30

const MIN_SCAN_CONTEXT_MINUTES = 20

export function minChartScanBars(lookbackMinutes: number): number {
  return Math.min(MIN_SCAN_CONTEXT_MINUTES, Math.max(2, lookbackMinutes))
}

export function chartScanContextMinutes(lookbackMinutes: number): number {
  return Math.max(lookbackMinutes, MIN_SCAN_CONTEXT_MINUTES)
}

export function isChartScanLookbackMinutes(value: number): value is ChartScanLookbackMinutes {
  return CHART_SCAN_LOOKBACK_OPTIONS.some(option => option.minutes === value)
}

export function loadChartScanLookbackMinutes(): ChartScanLookbackMinutes {
  try {
    const raw = Number(localStorage.getItem(CHART_SCAN_LOOKBACK_KEY))
    if (isChartScanLookbackMinutes(raw)) return raw
  } catch {
    // ignore
  }
  return DEFAULT_CHART_SCAN_LOOKBACK_MINUTES
}

export function saveChartScanLookbackMinutes(minutes: ChartScanLookbackMinutes) {
  try {
    localStorage.setItem(CHART_SCAN_LOOKBACK_KEY, String(minutes))
  } catch {
    // ignore
  }
}

export function formatChartScanLookbackLabel(minutes: number): string {
  const match = CHART_SCAN_LOOKBACK_OPTIONS.find(option => option.minutes === minutes)
  if (match) return match.label
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

export function formatChartScanLookbackPhrase(minutes: number): string {
  const label = formatChartScanLookbackLabel(minutes)
  return label === '1h' ? 'last hour' : `last ${label}`
}
