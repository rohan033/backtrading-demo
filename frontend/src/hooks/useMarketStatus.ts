import { useCallback, useEffect, useState } from 'react'

import {
  fetchMarketStatus,
  marketStatusLabel,
  type MarketStatusPayload,
} from '../lib/marketStatus'

const POLL_MS = 60_000

export function useMarketStatus(exchange = 'US') {
  const [payload, setPayload] = useState<MarketStatusPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = useCallback(async (force = false) => {
    try {
      const response = await fetchMarketStatus(exchange, force)
      setPayload(response.data)
      setError('')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Market status unavailable'
      setError(message)
      setPayload(null)
    } finally {
      setLoading(false)
    }
  }, [exchange])

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => {
      void refresh()
    }, POLL_MS)
    return () => window.clearInterval(id)
  }, [refresh])

  return {
    payload,
    label: marketStatusLabel(payload),
    loading,
    error,
    refresh,
    isOpen: Boolean(payload?.isOpen),
    session: payload?.session ?? null,
  }
}
