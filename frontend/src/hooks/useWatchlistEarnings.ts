import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  fetchWatchlistEarnings,
  type EarningsMonitorAlert,
  type WatchlistEarningsEvent,
} from '../lib/marketResearch'
import { showPlatformToast } from '../lib/platform-toast'

const REFRESH_MS = 15 * 60 * 1000
const DISMISS_KEY_PREFIX = 'earnings-monitor-dismissed'
const TOAST_KEY_PREFIX = 'earnings-monitor-toast'

type UseWatchlistEarningsOptions = {
  enabled?: boolean
  pastDays?: number
  futureDays?: number
  onOpenEarnings?: () => void
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function loadDismissedIds(): Set<string> {
  try {
    const raw = sessionStorage.getItem(`${DISMISS_KEY_PREFIX}:${todayKey()}`)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as string[]
    return new Set(Array.isArray(parsed) ? parsed : [])
  } catch {
    return new Set()
  }
}

function saveDismissedIds(ids: Set<string>) {
  try {
    sessionStorage.setItem(`${DISMISS_KEY_PREFIX}:${todayKey()}`, JSON.stringify([...ids]))
  } catch {
    // sessionStorage may be unavailable
  }
}

function loadToastedIds(): Set<string> {
  try {
    const raw = sessionStorage.getItem(`${TOAST_KEY_PREFIX}:${todayKey()}`)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as string[]
    return new Set(Array.isArray(parsed) ? parsed : [])
  } catch {
    return new Set()
  }
}

function saveToastedIds(ids: Set<string>) {
  try {
    sessionStorage.setItem(`${TOAST_KEY_PREFIX}:${todayKey()}`, JSON.stringify([...ids]))
  } catch {
    // ignore
  }
}

export function useWatchlistEarnings(options: UseWatchlistEarningsOptions = {}) {
  const {
    enabled = true,
    pastDays = 14,
    futureDays = 90,
    onOpenEarnings,
  } = options

  const [events, setEvents] = useState<WatchlistEarningsEvent[]>([])
  const [monitors, setMonitors] = useState<EarningsMonitorAlert[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => loadDismissedIds())
  const toastedRef = useRef<Set<string>>(loadToastedIds())
  const onOpenEarningsRef = useRef(onOpenEarnings)

  useEffect(() => {
    onOpenEarningsRef.current = onOpenEarnings
  }, [onOpenEarnings])

  const refresh = useCallback(async (force = false) => {
    if (!enabled) return
    setError('')
    try {
      const payload = await fetchWatchlistEarnings({ pastDays, futureDays, refresh: force })
      const rows = Array.isArray(payload.data) ? payload.data : []
      const alerts = Array.isArray(payload.monitor) ? payload.monitor : []
      setEvents(rows)
      setMonitors(alerts)

      for (const alert of alerts) {
        if (alert.phase !== 'post_earnings') continue
        if (toastedRef.current.has(alert.id)) continue
        toastedRef.current.add(alert.id)
        saveToastedIds(toastedRef.current)
        showPlatformToast({
          title: `Post-earnings watch: ${alert.symbol}`,
          message: alert.message,
          variant: 'warning',
          duration: 9000,
          actions: onOpenEarningsRef.current
            ? { label: 'Open', onClick: onOpenEarningsRef.current }
            : undefined,
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load watchlist earnings')
      setEvents([])
      setMonitors([])
    } finally {
      setLoading(false)
    }
  }, [enabled, pastDays, futureDays])

  useEffect(() => {
    if (!enabled) return
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, REFRESH_MS)
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [enabled, refresh])

  const activeMonitors = useMemo(
    () => monitors.filter(alert => !dismissedIds.has(alert.id)),
    [monitors, dismissedIds],
  )

  const dismissMonitor = useCallback((id: string) => {
    setDismissedIds(prev => {
      const next = new Set(prev)
      next.add(id)
      saveDismissedIds(next)
      return next
    })
  }, [])

  return {
    events,
    monitors: activeMonitors,
    allMonitors: monitors,
    loading,
    error,
    refresh,
    dismissMonitor,
  }
}
