import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  dismissAllTradeHaltNotifications,
  dismissTradeHaltNotification,
  fetchTradeHaltNotifications,
  fetchTradeHaltNotifySettings,
  fetchTradeHaltsForDay,
  type TradeHalt,
  type TradeHaltNotification,
} from '../lib/tradeHalts'

type UseTradeHaltNotificationsOptions = {
  enabled?: boolean
  day?: string
}

function tradeHaltsWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/ws/trade-halts`
}

function sortNotifications(items: TradeHaltNotification[]) {
  return [...items].sort(
    (a, b) => Date.parse(b.created_at || '') - Date.parse(a.created_at || ''),
  )
}

export function useTradeHaltNotifications(options: UseTradeHaltNotificationsOptions = {}) {
  const { enabled = true, day } = options
  const [notifications, setNotifications] = useState<TradeHaltNotification[]>([])
  const [halts, setHalts] = useState<TradeHalt[]>([])
  const [haltsDay, setHaltsDay] = useState<string | null>(day || null)
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)
  const seenRef = useRef<Set<string>>(new Set())
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const mergeNotifications = useCallback((incoming: TradeHaltNotification[]) => {
    setNotifications(prev => {
      const byId = new Map(prev.map(item => [item.id, item]))
      for (const item of incoming) {
        if (!item.id || item.dismissed) continue
        byId.set(item.id, item)
      }
      return sortNotifications([...byId.values()]).slice(0, 100)
    })
  }, [])

  const refreshSettings = useCallback(async () => {
    const prefs = await fetchTradeHaltNotifySettings()
    setNotificationsEnabled(prefs.notifications_enabled)
    if (!prefs.notifications_enabled) {
      setNotifications([])
    }
    return prefs.notifications_enabled
  }, [])

  const refreshDayHalts = useCallback(async () => {
    const result = await fetchTradeHaltsForDay(day ?? null)
    setHalts(result.data)
    setHaltsDay(result.day)
  }, [day])

  const dismiss = useCallback(async (id: string) => {
    await dismissTradeHaltNotification(id)
    setNotifications(prev => prev.filter(item => item.id !== id))
  }, [])

  const dismissAll = useCallback(async () => {
    await dismissAllTradeHaltNotifications()
    setNotifications([])
  }, [])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false

    void (async () => {
      const globalOn = await refreshSettings().catch(() => true)
      if (cancelled) return
      if (!globalOn) return

      const items = await fetchTradeHaltNotifications().catch(() => [])
      if (cancelled) return
      for (const item of items) seenRef.current.add(item.id)
      mergeNotifications(items)
    })()

    void refreshDayHalts().catch(() => {})

    const connect = () => {
      if (cancelled || wsRef.current?.readyState === WebSocket.OPEN) return
      const ws = new WebSocket(tradeHaltsWsUrl())
      wsRef.current = ws

      ws.onopen = () => {
        if (reconnectRef.current) {
          clearTimeout(reconnectRef.current)
          reconnectRef.current = null
        }
      }

      ws.onmessage = event => {
        let msg: { type?: string; notifications?: TradeHaltNotification[] }
        try {
          msg = JSON.parse(event.data)
        } catch {
          return
        }
        if (msg.type !== 'trade_halts' || !Array.isArray(msg.notifications)) return
        void refreshSettings()
          .then(globalOn => {
            if (!globalOn || cancelled) return
            const fresh: TradeHaltNotification[] = []
            for (const notification of msg.notifications || []) {
              if (!notification.id || seenRef.current.has(notification.id)) continue
              seenRef.current.add(notification.id)
              fresh.push(notification)
            }
            if (fresh.length) mergeNotifications(fresh)
            void refreshDayHalts().catch(() => {})
          })
          .catch(() => {})
      }

      ws.onclose = () => {
        wsRef.current = null
        if (!cancelled) reconnectRef.current = setTimeout(connect, 2500)
      }
    }

    connect()

    const pollSettings = window.setInterval(() => {
      void refreshSettings().catch(() => {})
    }, 15000)

    return () => {
      cancelled = true
      window.clearInterval(pollSettings)
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [enabled, mergeNotifications, refreshDayHalts, refreshSettings])

  return useMemo(
    () => ({
      notifications: notificationsEnabled ? notifications : [],
      halts,
      day: haltsDay,
      notificationsEnabled,
      dismiss,
      dismissAll,
      refreshDayHalts,
    }),
    [
      notifications,
      halts,
      haltsDay,
      notificationsEnabled,
      dismiss,
      dismissAll,
      refreshDayHalts,
    ],
  )
}
