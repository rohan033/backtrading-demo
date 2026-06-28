import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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

export type NewsUpdateGroup = {
  topic: string
  count: number
  latest: NewsNotification
  items: NewsNotification[]
}

type UseNewsNotificationsOptions = {
  enabled?: boolean
  onOpenUpdates?: () => void
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

function sortNotifications(items: NewsNotification[]) {
  return [...items].sort((a, b) => {
    const byCreated = Date.parse(b.created_at || '') - Date.parse(a.created_at || '')
    if (Number.isFinite(byCreated) && byCreated !== 0) return byCreated
    return (b.datetime || 0) - (a.datetime || 0)
  })
}

function groupNotifications(items: NewsNotification[]): NewsUpdateGroup[] {
  const byTopic = new Map<string, NewsNotification[]>()
  for (const item of sortNotifications(items)) {
    const topic = item.topic || 'Market'
    const bucket = byTopic.get(topic) || []
    bucket.push(item)
    byTopic.set(topic, bucket)
  }
  return [...byTopic.entries()]
    .map(([topic, groupedItems]) => ({
      topic,
      count: groupedItems.length,
      latest: groupedItems[0],
      items: groupedItems,
    }))
    .sort((a, b) => (b.latest.datetime || 0) - (a.latest.datetime || 0))
}

function toastNewsGroup(topic: string, notifications: NewsNotification[], onOpenUpdates?: () => void) {
  if (!notifications.length) return
  const count = notifications.length
  showPlatformToast({
    title: `News updates for ${topic} (+${count})`,
    message: count === 1 ? notifications[0].headline : `${count} new headlines available`,
    variant: 'success',
    duration: 7000,
    actions: onOpenUpdates
      ? {
          label: 'View',
          onClick: onOpenUpdates,
        }
      : undefined,
  })
}

export function useNewsNotifications(options: UseNewsNotificationsOptions = {}) {
  const { enabled = true, onOpenUpdates } = options
  const [notifications, setNotifications] = useState<NewsNotification[]>([])
  const seenRef = useRef<Set<string>>(new Set())
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onOpenUpdatesRef = useRef(onOpenUpdates)

  useEffect(() => {
    onOpenUpdatesRef.current = onOpenUpdates
  }, [onOpenUpdates])

  const mergeNotifications = useCallback((incoming: NewsNotification[]) => {
    setNotifications(prev => {
      const byId = new Map(prev.map(item => [item.id, item]))
      for (const item of incoming) {
        if (item.id) byId.set(item.id, item)
      }
      return sortNotifications([...byId.values()]).slice(0, 100)
    })
  }, [])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false

    void fetchRecentNewsNotifications()
      .then(items => {
        if (cancelled) return
        for (const item of items) seenRef.current.add(item.id)
        mergeNotifications(items)
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
        const fresh: NewsNotification[] = []
        for (const notification of msg.notifications) {
          if (!notification.id || seenRef.current.has(notification.id)) continue
          seenRef.current.add(notification.id)
          fresh.push(notification)
        }
        if (!fresh.length) return
        mergeNotifications(fresh)
        const grouped = groupNotifications(fresh)
        for (const group of grouped) {
          toastNewsGroup(group.topic, group.items, onOpenUpdatesRef.current)
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
  }, [enabled, mergeNotifications])

  return useMemo(
    () => ({
      notifications,
      groups: groupNotifications(notifications),
    }),
    [notifications],
  )
}
