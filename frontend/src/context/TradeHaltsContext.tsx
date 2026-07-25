import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import { useTradeHaltNotifications } from '../hooks/useTradeHaltNotifications'
import { buildHaltedBySymbol, lookupHaltedSymbol } from '../lib/tradeHaltsUi'
import { safeSetItem } from '../lib/safeStorage'
import type { TradeHalt, TradeHaltNotification } from '../lib/tradeHalts'

export const MAX_PINNED_HALTS = 6

const PINNED_HALTS_KEY = 'trade-halts-pinned-v2'
const PINNED_HALT_KEY = 'trade-halts-pinned-id'
const PINNED_HALT_SNAPSHOT_KEY = 'trade-halts-pinned-snapshot'

type PinnedHaltStore = {
  ids: string[]
  snapshots: Record<string, TradeHalt>
}

function isActiveHalt(halt: TradeHalt | null | undefined): halt is TradeHalt {
  return Boolean(halt && String(halt.status || '').toLowerCase() === 'halted')
}

function loadPinnedStore(): PinnedHaltStore {
  try {
    const raw = localStorage.getItem(PINNED_HALTS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as PinnedHaltStore
      const ids = Array.isArray(parsed.ids) ? parsed.ids.filter(Boolean).slice(0, MAX_PINNED_HALTS) : []
      const snapshots =
        parsed.snapshots && typeof parsed.snapshots === 'object' ? parsed.snapshots : {}
      return { ids, snapshots }
    }
  } catch {
    // fall through to legacy migration
  }

  try {
    const legacyId = localStorage.getItem(PINNED_HALT_KEY)
    const legacyRaw = localStorage.getItem(PINNED_HALT_SNAPSHOT_KEY)
    if (legacyId && legacyRaw) {
      const legacySnap = JSON.parse(legacyRaw) as TradeHalt
      if (legacySnap?.id) {
        return { ids: [legacyId], snapshots: { [legacyId]: legacySnap } }
      }
    }
  } catch {
    // ignore
  }

  return { ids: [], snapshots: {} }
}

function persistPinnedStore(store: PinnedHaltStore) {
  safeSetItem(PINNED_HALTS_KEY, JSON.stringify(store))
  try {
    localStorage.removeItem(PINNED_HALT_KEY)
    localStorage.removeItem(PINNED_HALT_SNAPSHOT_KEY)
  } catch {
    // ignore
  }
}

function resolvePinnedHalt(
  id: string,
  halts: TradeHalt[],
  snapshots: Record<string, TradeHalt>,
): TradeHalt | undefined {
  const snapshot = snapshots[id]
  const snapshotSymbol = String(snapshot?.symbol || '').trim().toUpperCase()

  // Prefer the live row (by id, else by symbol) from the full day feed so a
  // resume is reflected immediately and the pin drops off.
  const live =
    halts.find(item => item.id === id) ||
    (snapshotSymbol
      ? halts.find(item => String(item.symbol || '').trim().toUpperCase() === snapshotSymbol)
      : undefined)

  if (live) {
    return isActiveHalt(live) ? live : undefined
  }

  // Row not in the feed yet (initial load / straggler): bridge with the snapshot.
  return isActiveHalt(snapshot) ? snapshot : undefined
}

type TradeHaltsContextValue = {
  notifications: TradeHaltNotification[]
  halts: TradeHalt[]
  haltedBySymbol: Map<string, TradeHalt>
  day: string | null
  notificationsEnabled: boolean
  pinnedHalts: TradeHalt[]
  isPinnedHalt: (haltId: string) => boolean
  togglePinnedHalt: (halt: TradeHalt, pinned: boolean) => boolean
  unpinHalt: (haltId: string) => void
  dismiss: (id: string) => Promise<void>
  dismissAll: () => Promise<void>
  refreshDayHalts: () => Promise<void>
  isHalted: (ticker: string | null | undefined) => boolean
  haltFor: (ticker: string | null | undefined) => TradeHalt | undefined
}

const TradeHaltsContext = createContext<TradeHaltsContextValue | null>(null)

export function TradeHaltsProvider({ children }: { children: ReactNode }) {
  const {
    notifications,
    halts,
    day,
    notificationsEnabled,
    dismiss,
    dismissAll,
    refreshDayHalts,
  } = useTradeHaltNotifications()

  const [pinnedStore, setPinnedStore] = useState<PinnedHaltStore>(() => loadPinnedStore())

  const persistStore = useCallback((next: PinnedHaltStore) => {
    setPinnedStore(next)
    persistPinnedStore(next)
  }, [])

  const haltedBySymbol = useMemo(() => buildHaltedBySymbol(halts), [halts])

  const pinnedHalts = useMemo(() => {
    const resolved: TradeHalt[] = []
    for (const id of pinnedStore.ids) {
      const halt = resolvePinnedHalt(id, halts, pinnedStore.snapshots)
      if (halt) resolved.push(halt)
    }
    return resolved
  }, [halts, pinnedStore.ids, pinnedStore.snapshots])

  const isPinnedHalt = useCallback(
    (haltId: string) => pinnedStore.ids.includes(haltId),
    [pinnedStore.ids],
  )

  const unpinHalt = useCallback(
    (haltId: string) => {
      if (!pinnedStore.ids.includes(haltId)) return
      const ids = pinnedStore.ids.filter(id => id !== haltId)
      const snapshots = { ...pinnedStore.snapshots }
      delete snapshots[haltId]
      persistStore({ ids, snapshots })
    },
    [persistStore, pinnedStore.ids, pinnedStore.snapshots],
  )

  const togglePinnedHalt = useCallback(
    (halt: TradeHalt, pinned: boolean) => {
      if (!isActiveHalt(halt)) return false

      if (pinned) {
        if (pinnedStore.ids.includes(halt.id)) return true
        if (pinnedStore.ids.length >= MAX_PINNED_HALTS) return false

        const existingSymbol = pinnedHalts.some(
          item => item.symbol.toUpperCase() === halt.symbol.toUpperCase(),
        )
        if (existingSymbol) return true

        persistStore({
          ids: [...pinnedStore.ids, halt.id],
          snapshots: { ...pinnedStore.snapshots, [halt.id]: halt },
        })
        return true
      }

      unpinHalt(halt.id)
      return true
    },
    [persistStore, pinnedHalts, pinnedStore.ids, pinnedStore.snapshots, unpinHalt],
  )

  useEffect(() => {
    if (pinnedStore.ids.length === 0 || halts.length === 0) return

    const ids: string[] = []
    const snapshots: Record<string, TradeHalt> = {}

    for (const id of pinnedStore.ids) {
      const halt = resolvePinnedHalt(id, halts, pinnedStore.snapshots)
      if (!halt) continue
      ids.push(id)
      snapshots[id] = halt
    }

    if (ids.length !== pinnedStore.ids.length) {
      persistStore({ ids, snapshots })
    }
  }, [halts, persistStore, pinnedStore.ids, pinnedStore.snapshots])

  const value = useMemo(
    (): TradeHaltsContextValue => ({
      notifications,
      halts,
      haltedBySymbol,
      day,
      notificationsEnabled,
      pinnedHalts,
      isPinnedHalt,
      togglePinnedHalt,
      unpinHalt,
      dismiss,
      dismissAll,
      refreshDayHalts,
      isHalted: ticker => lookupHaltedSymbol(haltedBySymbol, ticker) != null,
      haltFor: ticker => lookupHaltedSymbol(haltedBySymbol, ticker),
    }),
    [
      notifications,
      halts,
      haltedBySymbol,
      day,
      notificationsEnabled,
      pinnedHalts,
      isPinnedHalt,
      togglePinnedHalt,
      unpinHalt,
      dismiss,
      dismissAll,
      refreshDayHalts,
    ],
  )

  return (
    <TradeHaltsContext.Provider value={value}>
      {children}
    </TradeHaltsContext.Provider>
  )
}

export function useTradeHalts() {
  const context = useContext(TradeHaltsContext)
  if (!context) {
    throw new Error('useTradeHalts must be used within TradeHaltsProvider')
  }
  return context
}
