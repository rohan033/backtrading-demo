import { useCallback, useEffect, useRef, useState } from 'react'

import { isA2uiSurfaceMessage } from '@/lib/agentA2uiCatalog'
import { buildAgentClientMonitorContext } from '@/lib/agentClientMonitorContext'
import {
  applyMonitorFlushInterval,
  CLIENT_MONITOR_FLUSH_MS,
  loadClientMonitorCache,
  recordClientMonitorFlush,
  restoreOrCreateClientMonitorCache,
  touchClientMonitorCache,
  type ClientMonitorCache,
  type ClientMonitorMarker,
} from '@/lib/agentClientMonitorCache'
import { AGENT_MONITOR_WS, flushClientMonitor, type AgentMonitorStatus } from '@/lib/agentMonitor'
import type { AgentThreadFocus } from '@/lib/agentThreads'
import { resolveHomeIndices, type HomeIndexSymbol } from '@/lib/homeIndices'
import { useHomeIndicesLiveFeed } from '@/hooks/useHomeIndicesLiveFeed'
import type { LinkedExecution } from '@/hooks/useAgentThreadExecutions'
import { useWatchlistStream } from '@/context/WatchlistStreamContext'
import type { PriceSample } from '@/lib/watchlistChangeColumns'
import { defaultAccountEnv, type WatchlistBroker } from '@/lib/watchlistBrokers'
import type { MonitorWatchTarget } from '@/hooks/useMultiSymbolLiveFeeds'

import type { AgentInteractionMode } from '@/lib/useAgentAguiChat'

type Params = {
  threadId: string
  focus: AgentThreadFocus | null
  watchTargets?: MonitorWatchTarget[]
  executions: LinkedExecution[]
  ltp?: number | null
  interactionMode?: AgentInteractionMode
  enabled?: boolean
  monitorActive?: boolean
  monitorUserEnabled?: boolean
  completed?: boolean
  flushIntervalMs?: number
  onAguiEvent: (event: Record<string, unknown>) => void
  onRunFinished?: () => void
  onMonitorStatus?: (status: AgentMonitorStatus) => void
  onMarkersChange?: (markers: ClientMonitorMarker[]) => void
}

function buildLocalStatus(
  threadId: string,
  cache: ClientMonitorCache,
  flushing: boolean,
  flushIntervalMs: number,
  options: { completed?: boolean; active?: boolean } = {},
): AgentMonitorStatus {
  const { completed = false, active = true } = options
  const nowSec = Date.now() / 1000
  const effectiveActive = active && !completed
  return {
    type: 'monitor_status',
    thread_id: threadId,
    active: effectiveActive,
    completed,
    client_mode: true,
    queue_size: 0,
    queue_max_items: 0,
    queue_max_age_sec: flushIntervalMs / 1000,
    queue_started_at: cache.windowStartedAt / 1000,
    flush_at: effectiveActive ? cache.nextFlushAt / 1000 : null,
    last_flush_at: cache.lastFlushAt ? cache.lastFlushAt / 1000 : undefined,
    flushing: effectiveActive && flushing,
    job_state: completed || !active
      ? 'stopped'
      : flushing
        ? 'waiting_agent'
        : 'running',
    monitor_state: completed ? 'completed' : effectiveActive ? 'active' : 'idle',
  }
}

export function useAgentClientMonitor({
  threadId,
  focus,
  watchTargets = [],
  executions,
  ltp = null,
  interactionMode = 'ask',
  enabled = true,
  monitorActive = false,
  monitorUserEnabled = false,
  completed = false,
  flushIntervalMs = CLIENT_MONITOR_FLUSH_MS,
  onAguiEvent,
  onRunFinished,
  onMonitorStatus,
  onMarkersChange,
}: Params) {
  const onAguiRef = useRef(onAguiEvent)
  const onRunFinishedRef = useRef(onRunFinished)
  const onMonitorStatusRef = useRef(onMonitorStatus)
  const onMarkersRef = useRef(onMarkersChange)
  const flushingRef = useRef(false)
  const cacheRef = useRef<ClientMonitorCache | null>(null)
  const monitorActiveRef = useRef(monitorActive)
  const interactionModeRef = useRef(interactionMode)
  interactionModeRef.current = interactionMode

  const flushIntervalRef = useRef(flushIntervalMs)
  const watchTargetsRef = useRef(watchTargets)
  const [indices, setIndices] = useState<HomeIndexSymbol[]>([])

  const { watchlists, ticks, historyRef } = useWatchlistStream()
  const broker = (focus?.broker || 'etoro') as WatchlistBroker
  const accountEnv = focus?.account_env || defaultAccountEnv(broker)
  const { ltps: indexLtps } = useHomeIndicesLiveFeed(indices, broker, accountEnv, enabled && indices.length > 0)

  flushIntervalRef.current = flushIntervalMs

  useEffect(() => {
    onAguiRef.current = onAguiEvent
  }, [onAguiEvent])

  useEffect(() => {
    onRunFinishedRef.current = onRunFinished
  }, [onRunFinished])

  useEffect(() => {
    onMonitorStatusRef.current = onMonitorStatus
  }, [onMonitorStatus])

  useEffect(() => {
    onMarkersRef.current = onMarkersChange
  }, [onMarkersChange])

  useEffect(() => {
    if (!enabled) return undefined
    let cancelled = false
    void resolveHomeIndices(broker, accountEnv).then(rows => {
      if (!cancelled) setIndices(rows)
    })
    return () => {
      cancelled = true
    }
  }, [accountEnv, broker, enabled])

  useEffect(() => {
    watchTargetsRef.current = watchTargets
  }, [watchTargets])

  useEffect(() => {
    monitorActiveRef.current = monitorActive
  }, [monitorActive])

  const statusOptions = useCallback(
    () => ({
      completed,
      active: monitorUserEnabled && !completed,
    }),
    [completed, monitorUserEnabled],
  )

  const publishStatus = useCallback(
    (cache: ClientMonitorCache, flushing: boolean) => {
      onMonitorStatusRef.current?.(
        buildLocalStatus(threadId, cache, flushing, flushIntervalRef.current, statusOptions()),
      )
    },
    [statusOptions, threadId],
  )

  const publishStatusRef = useRef(publishStatus)
  const flushNowRef = useRef<() => Promise<void>>(async () => {})
  const scheduleFlushRef = useRef<() => void>(() => {})

  useEffect(() => {
    publishStatusRef.current = publishStatus
  }, [publishStatus])

  const publishFromCache = useCallback((flushing?: boolean) => {
    const cache = cacheRef.current
      || loadClientMonitorCache(threadId)
      || restoreOrCreateClientMonitorCache(threadId, Date.now(), flushIntervalRef.current)
    cacheRef.current = cache
    const isFlushing = flushing ?? flushingRef.current
    publishStatusRef.current(cache, isFlushing)
  }, [threadId])

  const flushNow = useCallback(async (options?: { manual?: boolean; webNewsOnly?: boolean }) => {
    const manual = Boolean(options?.manual)
    if (!enabled || !focus?.symbol || flushingRef.current) return
    if (!manual && !monitorActiveRef.current) return

    const cached = cacheRef.current
      || restoreOrCreateClientMonitorCache(threadId, Date.now(), flushIntervalRef.current)
    cacheRef.current = cached
    flushingRef.current = true
    publishStatus(cached, true)

    try {
      const targets = watchTargetsRef.current.length
        ? watchTargetsRef.current
        : focus
          ? [{ focus, ltp, dedicatedSamples: [] as PriceSample[] }]
          : []

      const context = await buildAgentClientMonitorContext({
        focus,
        ltp,
        watchTargets: targets,
        watchlists,
        ticks,
        historyRef,
        indices,
        indexLtps,
        executions,
        windowMinutes: flushIntervalRef.current / 60_000,
      })

      const candidateSampleCount = context.candidates.reduce(
        (sum, row) => sum + row.price.samples.length,
        0,
      )
      const eventCount =
        context.news.length
        + context.market_headlines.length
        + context.positions.length
        + candidateSampleCount
        + context.indices.length

      await flushClientMonitor(threadId, context, {
        webNewsOnly: Boolean(options?.webNewsOnly),
        executionDecision: true,
        interactionMode: interactionModeRef.current,
      })

      const markerLabel = context.candidates.length > 1
        ? context.candidates.map(row => row.symbol.split('-')[0]).join(', ')
        : focus.symbol
      const marker: ClientMonitorMarker = {
        id: `monitor-${Date.now()}`,
        time: Math.floor(Date.now() / 1000),
        symbol: markerLabel,
        eventCount: Math.max(eventCount, 1),
      }
      const nextCache = recordClientMonitorFlush(
        cached,
        marker,
        {
          id: marker.id,
          at: Date.now(),
          symbol: markerLabel,
          eventCount: marker.eventCount,
        },
        Date.now(),
        flushIntervalRef.current,
      )
      cacheRef.current = nextCache
      onMarkersRef.current?.(nextCache.markers)
      publishStatus(nextCache, false)
    } catch {
      publishStatus(cached, false)
    } finally {
      flushingRef.current = false
    }
  }, [
    enabled,
    executions,
    focus,
    historyRef,
    indexLtps,
    indices,
    ltp,
    publishStatus,
    threadId,
    ticks,
    watchlists,
  ])

  useEffect(() => {
    flushNowRef.current = flushNow
  }, [flushNow])

  useEffect(() => {
    if (!enabled || !threadId || !focus?.symbol) return undefined

    const restored = loadClientMonitorCache(threadId)
      || restoreOrCreateClientMonitorCache(threadId, Date.now(), flushIntervalRef.current)
    cacheRef.current = touchClientMonitorCache(restored)
    publishFromCache(false)

    let cancelled = false
    let socket: WebSocket | null = null
    let reconnectTimer: number | null = null

    const connect = () => {
      if (cancelled) return
      socket = new WebSocket(AGENT_MONITOR_WS)
      socket.onopen = () => {
        socket?.send(JSON.stringify({ type: 'subscribe', thread_id: threadId }))
      }
      socket.onmessage = event => {
        try {
          const payload = JSON.parse(event.data) as Record<string, unknown>
          if (isA2uiSurfaceMessage(payload) || payload.type === 'a2ui_tool_log') {
            onAguiRef.current(payload)
          }
          if (payload.type === 'RUN_FINISHED') {
            flushingRef.current = false
            publishFromCache(false)
            onRunFinishedRef.current?.()
          }
          if (payload.type === 'THREAD_UPDATED') {
            onAguiRef.current(payload)
          }
          if (payload.type === 'monitor_status') {
            const server = payload as AgentMonitorStatus
            if (server.completed) {
              onMonitorStatusRef.current?.({ ...server, client_mode: true })
              return
            }
            const serverFlushing = Boolean(server.flushing || server.job_state === 'waiting_agent')
            flushingRef.current = serverFlushing
            publishFromCache(serverFlushing)
          }
        } catch {
          // ignore malformed monitor events
        }
      }
      socket.onclose = () => {
        if (!cancelled) reconnectTimer = window.setTimeout(connect, 3000)
      }
    }

    connect()

    return () => {
      cancelled = true
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer)
      socket?.close()
    }
  }, [enabled, focus?.symbol, publishFromCache, threadId])

  useEffect(() => {
    if (!enabled || !threadId) return
    publishFromCache(flushingRef.current)
  }, [completed, enabled, monitorUserEnabled, publishFromCache, threadId])

  useEffect(() => {
    if (!enabled || !threadId || !monitorUserEnabled) return
    const cache = loadClientMonitorCache(threadId)
    if (!cache) return
    cacheRef.current = touchClientMonitorCache(cache)
    publishFromCache(flushingRef.current)
  }, [enabled, monitorUserEnabled, publishFromCache, threadId])

  useEffect(() => {
    if (!enabled || !threadId) return
    const cache = cacheRef.current || loadClientMonitorCache(threadId)
    if (!cache) return
    cacheRef.current = applyMonitorFlushInterval(cache, flushIntervalMs)
    publishFromCache(flushingRef.current)
  }, [enabled, flushIntervalMs, publishFromCache, threadId])

  useEffect(() => {
    if (!enabled || !threadId || !focus?.symbol) return undefined
    if (!monitorActive || completed) {
      return undefined
    }

    let cancelled = false
    let flushTimer: number | null = null

    const scheduleFlush = () => {
      if (flushTimer != null) window.clearTimeout(flushTimer)
      const current = cacheRef.current
        || restoreOrCreateClientMonitorCache(threadId, Date.now(), flushIntervalRef.current)
      cacheRef.current = current
      const delay = Math.max(0, current.nextFlushAt - Date.now())
      flushTimer = window.setTimeout(() => {
        if (cancelled || !monitorActiveRef.current) return
        void flushNowRef.current().finally(() => {
          if (!cancelled && monitorActiveRef.current) scheduleFlush()
        })
      }, delay)
      publishFromCache(flushingRef.current)
    }

    scheduleFlushRef.current = scheduleFlush
    scheduleFlush()

    return () => {
      cancelled = true
      if (flushTimer != null) window.clearTimeout(flushTimer)
    }
  }, [
    completed,
    enabled,
    focus?.symbol,
    flushIntervalMs,
    monitorActive,
    threadId,
  ])

  useEffect(() => {
    if (!enabled || !monitorActive) return undefined
    const id = window.setInterval(() => {
      publishFromCache(flushingRef.current)
    }, 1_000)
    return () => window.clearInterval(id)
  }, [enabled, monitorActive, publishFromCache])

  useEffect(() => {
    if (!enabled || !monitorActive) return undefined
    const onResume = () => {
      const cache = cacheRef.current || loadClientMonitorCache(threadId)
      if (!cache || !monitorActiveRef.current) return
      if (cache.nextFlushAt <= Date.now() + 1_000) {
        void flushNowRef.current()
        return
      }
      scheduleFlushRef.current()
    }
    window.addEventListener('focus', onResume)
    document.addEventListener('visibilitychange', onResume)
    return () => {
      window.removeEventListener('focus', onResume)
      document.removeEventListener('visibilitychange', onResume)
    }
  }, [enabled, monitorActive, threadId])

  const sendMonitorNow = useCallback(
    () => flushNow({ manual: true, webNewsOnly: false }),
    [flushNow],
  )

  return { flushNow, sendMonitorNow }
}
