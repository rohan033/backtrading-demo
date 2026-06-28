const CHROME_HIDDEN_KEY = 'watchlist-chrome-hidden-v1'

export const WL_CHROME_HIDDEN_CHANGED_EVENT = 'wl-chrome-hidden-changed'

export function loadWatchlistChromeHidden(): boolean {
  try {
    return localStorage.getItem(CHROME_HIDDEN_KEY) === '1'
  } catch {
    return false
  }
}

export function saveWatchlistChromeHidden(hidden: boolean): void {
  localStorage.setItem(CHROME_HIDDEN_KEY, hidden ? '1' : '0')
}

export function notifyWatchlistChromeHiddenChanged(): void {
  window.dispatchEvent(new Event(WL_CHROME_HIDDEN_CHANGED_EVENT))
}
