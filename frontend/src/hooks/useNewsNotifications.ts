import { useEffect, useRef } from 'react'

import { showPlatformToast } from '../lib/platform-toast'

export type NewsNotification = {
  id: string
  scope: 'company' | 'market' | string
  topic: string
  item_id: number
  headline: string
  source?: string | null
  url?: string | null
  datetime?: number | null
  created_at: string
}

function newsWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/ws/news`
}

async function fetchRecentNewsNotifications(): Promise<NewsNotification[]> {
  const res = await fetch('/api/market/news-notifications?limit=100')
  if (!res.ok) return []
  const payload = (await res.json()) as { data?: NewsNotification[] }
  return Array.isArray(payload.data) ? payload.data : []
}

function toastNewsNotification(notification: NewsNotification) {
  showPlatformToast({
    title: `${notification.topic} news`,
    message: notification.source
      ? `${notification.headline} (${notification.source})`
      : notification.headline,
    variant: 'success',
    duration: 8000,
    actions: notification.url
      ? {
          label: 'Open',
          onClick: () => window.open(notification.url || '', '_blank', 'noopener,noreferrer'),
        }
      : undefined,
  })
}

export function useNewsNotifications(enabled = true) {
  const seenRef = useRef<Set<string>>(new Set())
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false

    void fetchRecentNewsNotifications()
      .then(items => {
        if (cancelled) return
        for (const item of items) seenRef.current.add(item.id)
      })
      .catch(() => {
        // Notification history is best-effort; live WebSocket alerts still work.
      })

    const connect = () => {
      if (cancelled || wsRef.current?.readyState === WebSocket.OPEN) return
      const ws = new WebSocket(newsWsUrl())
      wsRef.current = ws

      ws.onopen = () => {
        if (reconnectRef.current) {
          clearTimeout(reconnectRef.current)
          reconnectRef.current = null
        }
      }

      ws.onmessage = event => {
        let msg: { type?: string; notifications?: NewsNotification[] }
        try {
          msg = JSON.parse(event.data)
        } catch {
          return
        }
        if (msg.type !== 'news' || !Array.isArray(msg.notifications)) return
        for (const notification of msg.notifications) {
          if (!notification.id || seenRef.current.has(notification.id)) continue
          seenRef.current.add(notification.id)
          toastNewsNotification(notification)
        }
      }

      ws.onclose = () => {
        wsRef.current = null
        if (!cancelled) reconnectRef.current = setTimeout(connect, 2500)
      }
    }

    connect()
    return () => {
      cancelled = true
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [enabled])
}
