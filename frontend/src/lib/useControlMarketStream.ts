import { useEffect, useMemo, useRef, useState } from 'react'

import { CONTROL_MARKET_WS, type ControlMarketSubscribe } from '@/lib/controlMarketWs'

const STALE_MS = 15000
const FIRST_TICK_MS = 10000

function useNow(intervalMs: number | null) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (intervalMs == null) return undefined
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}

export type MarketStreamStatus = {
  status: string
  label: string
  tone: 'muted' | 'warn' | 'ok' | 'error'
}

export function useControlMarketStream(subscribe: ControlMarketSubscribe | null, enabled = true) {
  const [ltp, setLtp] = useState<number | null>(null)
  const [connected, setConnected] = useState(false)
  const [connectedAt, setConnectedAt] = useState<number | null>(null)
  const [lastTickAt, setLastTickAt] = useState<number | null>(null)
  const [error, setError] = useState('')
  const socketRef = useRef<WebSocket | null>(null)
  const nowMs = useNow(enabled && subscribe ? 5000 : null)

  const streamStatus = useMemo((): MarketStreamStatus => {
    if (!enabled || !subscribe?.symbol) {
      return { status: 'idle', label: 'No symbol', tone: 'muted' }
    }
    if (error) {
      return { status: 'error', label: error, tone: 'error' }
    }
    if (!connected) {
      return { status: 'connecting', label: 'Connecting…', tone: 'warn' }
    }
    if (!lastTickAt) {
      const connectedForMs = connectedAt ? nowMs - connectedAt : 0
      if (connectedForMs >= FIRST_TICK_MS) {
        return { status: 'no_ticks', label: 'Connected — waiting for price', tone: 'error' }
      }
      return { status: 'waiting', label: 'Waiting for first tick…', tone: 'warn' }
    }
    const ageMs = nowMs - lastTickAt
    const ageSec = Math.max(0, Math.round(ageMs / 1000))
    if (ageMs > STALE_MS) {
      return { status: 'stale', label: `Stale (${ageSec}s ago)`, tone: 'error' }
    }
    return { status: 'flowing', label: 'Live', tone: 'ok' }
  }, [enabled, subscribe?.symbol, error, connected, connectedAt, lastTickAt, nowMs])

  useEffect(() => {
    if (!enabled || !subscribe?.symbol) {
      setLtp(null)
      setConnected(false)
      setConnectedAt(null)
      setLastTickAt(null)
      setError('')
      if (socketRef.current) {
        socketRef.current.close()
        socketRef.current = null
      }
      return undefined
    }

    setLtp(null)
    setConnected(false)
    setConnectedAt(null)
    setLastTickAt(null)
    setError('')

    const ws = new WebSocket(CONTROL_MARKET_WS)
    socketRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      setConnectedAt(Date.now())
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          broker: subscribe.broker,
          token: String(subscribe.token || subscribe.symbol),
          symbol: subscribe.symbol,
          exchange: subscribe.exchange || (subscribe.broker === 'us' ? 'US' : 'NSE'),
          account_env: subscribe.account_env || 'live',
          use_fake_client: Boolean(subscribe.use_fake_client),
          feed_mode: subscribe.broker === 'angel' ? subscribe.feed_mode || 'websocket' : 'websocket',
        }),
      )
    }

    ws.onmessage = event => {
      try {
        const msg = JSON.parse(event.data) as { type?: string; ltp?: number; message?: string }
        if (msg.type === 'tick' && msg.ltp != null) {
          const nextLtp = Number(msg.ltp)
          if (!Number.isFinite(nextLtp) || nextLtp <= 0) return
          setLtp(nextLtp)
          setLastTickAt(Date.now())
          setError('')
        } else if (msg.type === 'error') {
          setError(msg.message || 'Market stream failed')
        }
      } catch {
        setError('Invalid market message')
      }
    }

    ws.onerror = () => setError('Market websocket failed')
    ws.onclose = () => {
      setConnected(false)
      setConnectedAt(null)
      if (socketRef.current === ws) socketRef.current = null
    }

    return () => {
      ws.close()
      if (socketRef.current === ws) socketRef.current = null
    }
  }, [
    enabled,
    subscribe?.broker,
    subscribe?.symbol,
    subscribe?.token,
    subscribe?.exchange,
    subscribe?.account_env,
    subscribe?.use_fake_client,
    subscribe?.feed_mode,
  ])

  return { ltp, error, streamStatus, connected, lastTickAt }
}
