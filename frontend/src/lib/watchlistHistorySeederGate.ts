import { loadWatchlistViewMode } from './watchlistViewMode'

/** Skip bulk seeding in charts view — history loads on maximize for one symbol only. */
function initialSeederEnabled(): boolean {
  try {
    return loadWatchlistViewMode() !== 'charts'
  } catch {
    return true
  }
}

let enabled = initialSeederEnabled()

export function setWatchlistHistorySeederEnabled(next: boolean): void {
  enabled = next
}

export function isWatchlistHistorySeederEnabled(): boolean {
  return enabled
}
