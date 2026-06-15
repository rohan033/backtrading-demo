const ACTIVE_PANEL_KEY = 'watchlist-active-panel-v1'

export function loadActivePanelId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_PANEL_KEY)
  } catch {
    return null
  }
}

export function saveActivePanelId(panelId: string): void {
  localStorage.setItem(ACTIVE_PANEL_KEY, panelId)
}
