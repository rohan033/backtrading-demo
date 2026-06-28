import { useCallback, useEffect, useRef, useState } from 'react'

import {
  fetchCompanyNews,
  mergeCompanyNews,
  type CompanyNewsItem,
} from '../lib/companyNews'

export type CompanyNewsRefreshResult = {
  addedCount: number
  totalCount: number
}

export function useCompanyNews(symbol: string | null | undefined) {
  const [items, setItems] = useState<CompanyNewsItem[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null)
  const refreshLockRef = useRef(false)

  useEffect(() => {
    const trimmed = symbol?.trim()
    if (!trimmed) {
      setItems([])
      setError(null)
      setLoading(false)
      setLastRefreshedAt(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    void fetchCompanyNews(trimmed)
      .then(data => {
        if (!cancelled) {
          setItems(data)
          setLastRefreshedAt(Date.now())
        }
      })
      .catch(err => {
        if (!cancelled) {
          setItems([])
          setError(err instanceof Error ? err.message : 'Failed to load news')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [symbol])

  const refresh = useCallback(async (): Promise<CompanyNewsRefreshResult | null> => {
    const trimmed = symbol?.trim()
    if (!trimmed || refreshLockRef.current) return null

    refreshLockRef.current = true
    setRefreshing(true)
    setError(null)

    try {
      const incoming = await fetchCompanyNews(trimmed)
      let result: CompanyNewsRefreshResult = { addedCount: 0, totalCount: incoming.length }

      setItems(prev => {
        const merged = mergeCompanyNews(prev, incoming)
        result = { addedCount: merged.addedCount, totalCount: merged.items.length }
        return merged.items
      })
      setLastRefreshedAt(Date.now())
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to refresh news'
      setError(message)
      return null
    } finally {
      refreshLockRef.current = false
      setRefreshing(false)
    }
  }, [symbol])

  return { items, loading, refreshing, error, refresh, lastRefreshedAt }
}
