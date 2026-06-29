import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  fetchWatchlistInsiderTransactions,
  type InsiderTransaction,
} from '../lib/marketResearch'

const REFRESH_MS = 5 * 60 * 1000

type UseWatchlistInsiderOptions = {
  enabled?: boolean
  days?: number
  symbol?: string
}

function newsWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/ws/news`
}

export function useWatchlistInsiderTransactions(options: UseWatchlistInsiderOptions = {}) {
  const { enabled = true, days = 90, symbol = '' } = options
  const [transactions, setTransactions] = useState<InsiderTransaction[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastPolledAt, setLastPolledAt] = useState<string | null>(null)
  const seenRef = useRef<Set<string>>(new Set())
  const wsRef = useRef<WebSocket | null>(null)

  const refresh = useCallback(async (force = false) => {
    if (!enabled) return
    setError('')
    try {
      const payload = await fetchWatchlistInsiderTransactions({
        days,
        symbol: symbol.trim() || undefined,
        refresh: force,
      })
      const rows = Array.isArray(payload.data) ? payload.data : []
      setTransactions(rows)
      setLastPolledAt(typeof payload.meta?.lastPolledAt === 'string' ? payload.meta.lastPolledAt : null)
      for (const row of rows) {
        if (row.id) seenRef.current.add(row.id)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load insider transactions')
      setTransactions([])
    } finally {
      setLoading(false)
    }
  }, [enabled, days, symbol])

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

  useEffect(() => {
    if (!enabled) return
    let cancelled = false

    const connect = () => {
      if (cancelled || wsRef.current?.readyState === WebSocket.OPEN) return
      const ws = new WebSocket(newsWsUrl())
      wsRef.current = ws

      ws.onmessage = event => {
        let msg: { type?: string; transactions?: InsiderTransaction[] }
        try {
          msg = JSON.parse(event.data)
        } catch {
          return
        }
        if (msg.type !== 'insider' || !Array.isArray(msg.transactions)) return
        const fresh = msg.transactions.filter(row => row.id && !seenRef.current.has(row.id))
        if (!fresh.length) return
        for (const row of fresh) {
          if (row.id) seenRef.current.add(row.id)
        }
        setTransactions(prev => {
          const byId = new Map(prev.map(item => [item.id, item]))
          for (const row of fresh) {
            if (row.id) byId.set(row.id, row)
          }
          return [...byId.values()].sort((a, b) =>
            String(b.transactionDate || b.filingDate).localeCompare(String(a.transactionDate || a.filingDate)),
          )
        })
      }

      ws.onclose = () => {
        wsRef.current = null
        if (!cancelled) window.setTimeout(connect, 2500)
      }
    }

    connect()
    return () => {
      cancelled = true
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [enabled])

  const symbols = useMemo(() => {
    const set = new Set<string>()
    for (const row of transactions) {
      const label = row.watchlistRefs?.[0]?.tradingsymbol || row.symbol || row.finnhubSymbol
      if (label) set.add(label)
    }
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [transactions])

  return {
    transactions,
    symbols,
    loading,
    error,
    lastPolledAt,
    refresh,
  }
}
