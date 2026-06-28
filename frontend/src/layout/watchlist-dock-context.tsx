import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

const OPEN_STORAGE_KEY = 'strategy-desk-watchlist-dock-open'
const TAB_STORAGE_KEY = 'strategy-desk-watchlist-dock-tab'

export type WatchlistDockTab = 'watchlists' | 'news' | 'market'

type WatchlistDockContextValue = {
  open: boolean
  toggle: () => void
  setOpen: (open: boolean) => void
  tab: WatchlistDockTab
  setTab: (tab: WatchlistDockTab) => void
  newsSymbol: string | null
  setNewsSymbol: (symbol: string | null) => void
}

const WatchlistDockContext = createContext<WatchlistDockContextValue | null>(null)

function loadDockTab(): WatchlistDockTab {
  try {
    const stored = localStorage.getItem(TAB_STORAGE_KEY)
    if (stored === 'news' || stored === 'market') return stored
  } catch {
    // ignore storage errors
  }
  return 'watchlists'
}

export function WatchlistDockProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_STORAGE_KEY) === '1'
    } catch {
      return false
    }
  })
  const [tab, setTab] = useState<WatchlistDockTab>(() => loadDockTab())
  const [newsSymbol, setNewsSymbol] = useState<string | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_STORAGE_KEY, open ? '1' : '0')
    } catch {
      // ignore storage errors
    }
  }, [open])

  useEffect(() => {
    try {
      localStorage.setItem(TAB_STORAGE_KEY, tab)
    } catch {
      // ignore storage errors
    }
  }, [tab])

  return (
    <WatchlistDockContext.Provider
      value={{
        open,
        toggle: () => setOpen(value => !value),
        setOpen,
        tab,
        setTab,
        newsSymbol,
        setNewsSymbol,
      }}
    >
      {children}
    </WatchlistDockContext.Provider>
  )
}

export function useWatchlistDock() {
  const context = useContext(WatchlistDockContext)
  if (!context) {
    throw new Error('useWatchlistDock must be used within WatchlistDockProvider')
  }
  return context
}
