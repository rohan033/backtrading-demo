import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

const STORAGE_KEY = 'strategy-desk-watchlist-dock-open'

type WatchlistDockContextValue = {
  open: boolean
  toggle: () => void
  setOpen: (open: boolean) => void
}

const WatchlistDockContext = createContext<WatchlistDockContextValue | null>(null)

export function WatchlistDockProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, open ? '1' : '0')
    } catch {
      // ignore storage errors
    }
  }, [open])

  return (
    <WatchlistDockContext.Provider
      value={{ open, toggle: () => setOpen(value => !value), setOpen }}
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
