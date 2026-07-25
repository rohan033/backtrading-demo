import { useCallback, useEffect, useRef, useState } from 'react'

import {
  fetchScreeners,
  refreshScreener,
  type Screener,
} from '../lib/screenerApi'

const DEFAULT_REFRESH_SECONDS = 60
const TICK_MS = 200
const STAGGER_MS = 2500

export function useOverviewScreeners(enabled: boolean) {
  const [screeners, setScreeners] = useState<Screener[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set())
  const [refreshProgress, setRefreshProgress] = useState<Record<string, number>>({})
  const screenersRef = useRef<Screener[]>([])
  const cycleStartRef = useRef<Record<string, number>>({})
  const visibleRef = useRef(typeof document !== 'undefined' ? document.visibilityState === 'visible' : true)
  const refreshInFlight = useRef<Set<string>>(new Set())
  const staggerQueueRef = useRef<Promise<void>>(Promise.resolve())

  const loadAll = useCallback(async () => {
    try {
      const data = await fetchScreeners(true)
      screenersRef.current = data
      setScreeners(data)
      const now = Date.now()
      for (const screener of data) {
        cycleStartRef.current[screener.id] = now
      }
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load screeners')
    } finally {
      setLoading(false)
    }
  }, [])

  const doRefresh = useCallback(async (screenerId: string) => {
    if (refreshInFlight.current.has(screenerId)) return
    refreshInFlight.current.add(screenerId)
    setRefreshingIds(prev => new Set(prev).add(screenerId))
    try {
      const updated = await refreshScreener(screenerId)
      screenersRef.current = screenersRef.current.map(item =>
        item.id === screenerId ? updated : item,
      )
      setScreeners([...screenersRef.current])
      cycleStartRef.current[screenerId] = Date.now()
      setRefreshProgress(prev => ({ ...prev, [screenerId]: 100 }))
    } catch {
      // Keep stale data; next cycle retries.
    } finally {
      refreshInFlight.current.delete(screenerId)
      setRefreshingIds(prev => {
        const next = new Set(prev)
        next.delete(screenerId)
        return next
      })
    }
  }, [])

  const queueRefresh = useCallback((screenerId: string) => {
    staggerQueueRef.current = staggerQueueRef.current.then(async () => {
      await doRefresh(screenerId)
      await new Promise(resolve => window.setTimeout(resolve, STAGGER_MS))
    })
  }, [doRefresh])

  useEffect(() => {
    if (!enabled) return
    void loadAll()
  }, [enabled, loadAll])

  useEffect(() => {
    if (!enabled) return

    const onVisibility = () => {
      visibleRef.current = document.visibilityState === 'visible'
      if (visibleRef.current) {
        const now = Date.now()
        for (const screener of screenersRef.current) {
          cycleStartRef.current[screener.id] = now
        }
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    const intervalId = window.setInterval(() => {
      if (!visibleRef.current) return
      const now = Date.now()
      const nextProgress: Record<string, number> = {}
      for (const screener of screenersRef.current) {
        const seconds = Number(screener.auto_refresh_seconds || 0) || DEFAULT_REFRESH_SECONDS
        const started = cycleStartRef.current[screener.id] ?? now
        const totalMs = seconds * 1000
        const elapsed = now - started
        nextProgress[screener.id] = Math.max(0, 100 - (elapsed / totalMs) * 100)
        if (elapsed >= totalMs) {
          cycleStartRef.current[screener.id] = now
          queueRefresh(screener.id)
        }
      }
      setRefreshProgress(nextProgress)
    }, TICK_MS)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.clearInterval(intervalId)
    }
  }, [enabled, queueRefresh])

  const applyScreenerOrder = useCallback((orderedIds: string[]) => {
    const byId = new Map(screenersRef.current.map(item => [item.id, item]))
    const next: Screener[] = []
    const seen = new Set<string>()
    for (const id of orderedIds) {
      const item = byId.get(id)
      if (!item) continue
      next.push(item)
      seen.add(id)
    }
    for (const item of screenersRef.current) {
      if (!seen.has(item.id)) next.push(item)
    }
    screenersRef.current = next
    setScreeners(next)
  }, [])

  return {
    screeners,
    loading,
    error,
    refreshingIds,
    refreshProgress,
    reload: loadAll,
    applyScreenerOrder,
  }
}
