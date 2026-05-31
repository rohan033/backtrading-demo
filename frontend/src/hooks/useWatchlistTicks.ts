import { useCallback, useEffect, useRef, useState } from 'react'

import type { Watchlist, WatchlistTick } from '../lib/watchlists'
import { watchlistTickKey, watchlistWsUrl } from '../lib/watchlists'

export function useWatchlistTicks(watchlists: Watchlist[], enabled: boolean) {
  const [ticks, setTicks] = useState<Record<string, WatchlistTick>>({})
  const [connected, setConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const syncPayload = useCallback(
    () =>
      watchlists.map(wl => ({
        id: wl.id,
        name: wl.name,
        broker: wl.broker || 'angel',
        account_env: wl.account_env || (wl.broker === 'etoro' ? 'demo' : 'live'),
        symbols: wl.symbols.map(s => ({
          symboltoken: s.symboltoken,
          tradingsymbol: s.tradingsymbol,
          exchange: s.exchange,
          symbol: s.symbol,
        })),
      })),
    [watchlists],
  )

  const sendSync = useCallback(
    (ws: WebSocket) => {
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify({ type: 'sync', watchlists: syncPayload() }))
    },
    [syncPayload],
  )

  useEffect(() => {
    if (!enabled) return

    const connect = () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) return
      const ws = new WebSocket(watchlistWsUrl())
      wsRef.current = ws

      ws.onopen = () => {
        setConnected(true)
        if (reconnectRef.current) {
          clearTimeout(reconnectRef.current)
          reconnectRef.current = null
        }
        sendSync(ws)
      }

      ws.onclose = () => {
        setConnected(false)
        reconnectRef.current = setTimeout(connect, 2500)
      }

      ws.onmessage = event => {
        const msg = JSON.parse(event.data)
        if (msg.type !== 'tick') return
        const token = String(msg.token)
        const broker = String(msg.broker || 'angel')
        const accountEnv = String(msg.account_env || 'live')
        const key = watchlistTickKey(broker, accountEnv, token)
        setTicks(prev => ({
          ...prev,
          [key]: {
            token,
            ltp: Number(msg.ltp),
            change_pct: Number(msg.change_pct),
            direction: msg.direction,
          },
        }))
      }
    }

    connect()
    return () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [enabled, sendSync])

  useEffect(() => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      sendSync(ws)
    }
  }, [watchlists, sendSync])

  return { ticks, connected }
}
