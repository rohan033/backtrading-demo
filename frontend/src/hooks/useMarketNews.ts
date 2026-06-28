import { useCallback, useEffect, useRef, useState } from 'react'

import {
  fetchMarketNews,
  loadMarketNewsCategory,
  maxMarketNewsId,
  mergeMarketNews,
  saveMarketNewsCategory,
  type MarketNewsCategory,
  type MarketNewsItem,
} from '../lib/marketNews'

export type MarketNewsRefreshResult = {
  addedCount: number
  totalCount: number
}

export function useMarketNews() {
  const [category, setCategoryState] = useState<MarketNewsCategory>(() => loadMarketNewsCategory())
  const [items, setItems] = useState<MarketNewsItem[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refreshLockRef = useRef(false)

  const setCategory = useCallback((next: MarketNewsCategory) => {
    setCategoryState(next)
    saveMarketNewsCategory(next)
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setItems([])

    void fetchMarketNews(category, 0)
      .then(data => {
        if (!cancelled) setItems(data)
      })
      .catch(err => {
        if (!cancelled) {
          setItems([])
          setError(err instanceof Error ? err.message : 'Failed to load market news')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [category])

  const refresh = useCallback(async (): Promise<MarketNewsRefreshResult | null> => {
    if (refreshLockRef.current) return null

    refreshLockRef.current = true
    setRefreshing(true)
    setError(null)

    try {
      const minId = maxMarketNewsId(items)
      const incoming = await fetchMarketNews(category, minId)
      let result: MarketNewsRefreshResult = { addedCount: 0, totalCount: items.length }

      setItems(prev => {
        const merged = mergeMarketNews(prev, incoming)
        result = { addedCount: merged.addedCount, totalCount: merged.items.length }
        return merged.items
      })
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to refresh market news'
      setError(message)
      return null
    } finally {
      refreshLockRef.current = false
      setRefreshing(false)
    }
  }, [category, items])

  return { category, setCategory, items, loading, refreshing, error, refresh }
}
