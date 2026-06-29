import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  fuzzyMatchLog,
  LOG_LEVEL_FILTERS,
  matchesLogLevelFilter,
  type LogLevelFilter,
} from '../lib/logFilters'
import { parseLogLine, type LogLineCategory, type ParsedLogLine } from '../lib/logLineStyle'

const MAX_RENDERED_LINES = 2500
const BATCH_FRAME_LINES = 120

export type LiveLogTarget = {
  /** Data-plane engine id used by /api/control/engines/{id}/logs/stream */
  id: string
  label: string
  logFile?: string | null
  isControlled?: boolean
  /** Controlled execution id for strategy deep links */
  executionId?: string | null
}

export type LiveLogStreamPhase = 'idle' | 'waiting' | 'loading' | 'live' | 'error'

export function useLiveLogStream(target: LiveLogTarget | null) {
  const [lines, setLines] = useState<ParsedLogLine[]>([])
  const [phase, setPhase] = useState<LiveLogStreamPhase>('idle')
  const [statusText, setStatusText] = useState('Connecting…')
  const [lineCount, setLineCount] = useState(0)
  const [fileSize, setFileSize] = useState(0)
  const [followTail, setFollowTail] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [levelFilters, setLevelFilters] = useState<Set<LogLevelFilter>>(new Set(['all']))

  const containerRef = useRef<HTMLDivElement | null>(null)
  const pendingLinesRef = useRef<string[]>([])
  const flushFrameRef = useRef<number | null>(null)
  const lineIndexRef = useRef(0)
  const atBottomRef = useRef(true)

  const targetId = target?.id ?? ''

  const flushPendingLines = useCallback(() => {
    flushFrameRef.current = null
    if (!pendingLinesRef.current.length) return

    const batch = pendingLinesRef.current.splice(0, BATCH_FRAME_LINES)
    setLines(prev => {
      const parsed = batch.map(line => {
        const entry = parseLogLine(line, lineIndexRef.current)
        lineIndexRef.current += 1
        return { ...entry, id: `${targetId}-${entry.id}` }
      })
      const next = [...prev, ...parsed]
      return next.length > MAX_RENDERED_LINES ? next.slice(-MAX_RENDERED_LINES) : next
    })

    if (pendingLinesRef.current.length) {
      flushFrameRef.current = window.requestAnimationFrame(flushPendingLines)
    }
  }, [targetId])

  const enqueueLines = useCallback((incoming: string[]) => {
    if (!incoming.length) return
    pendingLinesRef.current.push(...incoming)
    if (flushFrameRef.current == null) {
      flushFrameRef.current = window.requestAnimationFrame(flushPendingLines)
    }
  }, [flushPendingLines])

  useEffect(() => {
    if (!target?.id) {
      setLines([])
      setPhase('idle')
      setStatusText('')
      setLineCount(0)
      setFileSize(0)
      return undefined
    }

    lineIndexRef.current = 0
    pendingLinesRef.current = []
    if (flushFrameRef.current != null) {
      window.cancelAnimationFrame(flushFrameRef.current)
      flushFrameRef.current = null
    }
    setLines([])
    setLineCount(0)
    setFileSize(0)
    setPhase('loading')
    setStatusText('Opening log stream…')
    setSearchQuery('')
    setLevelFilters(new Set(['all']))
    atBottomRef.current = true

    const controller = new AbortController()
    const streamUrl = `/api/control/engines/${encodeURIComponent(target.id)}/logs/stream`

    async function consumeStream() {
      try {
        const res = await fetch(streamUrl, { signal: controller.signal })
        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.detail || data.message || `Stream failed (${res.status})`)
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const chunks = buffer.split('\n\n')
          buffer = chunks.pop() || ''

          for (const chunk of chunks) {
            const dataLine = chunk
              .split('\n')
              .find(line => line.startsWith('data: '))
            if (!dataLine) continue

            const payload = JSON.parse(dataLine.slice(6)) as {
              type: string
              message?: string
              lines?: string[]
              size?: number
              line_count?: number
            }

            if (payload.type === 'meta') {
              setFileSize(Number(payload.size || 0))
              setStatusText('Loading log from start…')
              setPhase('loading')
              continue
            }

            if (payload.type === 'waiting') {
              setPhase('waiting')
              setStatusText(payload.message || 'Waiting for log file…')
              continue
            }

            if (payload.type === 'error') {
              setPhase('error')
              setStatusText(payload.message || 'Log stream error')
              continue
            }

            if (payload.type === 'chunk' && payload.lines?.length) {
              enqueueLines(payload.lines)
              setLineCount(Number(payload.line_count || 0))
              if (payload.size) setFileSize(Number(payload.size))
              setPhase('loading')
              setStatusText(`Loading log… ${payload.line_count?.toLocaleString() || 0} lines`)
              continue
            }

            if (payload.type === 'caught_up') {
              setPhase('live')
              setLineCount(Number(payload.line_count || 0))
              setStatusText('Live tail')
              continue
            }

            if (payload.type === 'tail' && payload.lines?.length) {
              enqueueLines(payload.lines)
              setLineCount(Number(payload.line_count || 0))
              setPhase('live')
              setStatusText('Live tail')
            }
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return
        setPhase('error')
        setStatusText(err instanceof Error ? err.message : 'Log stream failed')
      }
    }

    consumeStream()

    return () => {
      controller.abort()
      if (flushFrameRef.current != null) {
        window.cancelAnimationFrame(flushFrameRef.current)
      }
    }
  }, [target, enqueueLines])

  useEffect(() => {
    const node = containerRef.current
    if (!node || !followTail || !atBottomRef.current) return
    node.scrollTop = node.scrollHeight
  }, [lines, followTail])

  const onScroll = () => {
    const node = containerRef.current
    if (!node) return
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight
    atBottomRef.current = distanceFromBottom < 48
  }

  const filteredLines = useMemo(() => {
    return lines.filter(line => {
      if (!matchesLogLevelFilter(line.category, levelFilters)) return false
      const searchable = `${line.timestamp || ''} ${line.message} ${line.raw}`
      return fuzzyMatchLog(searchQuery, searchable)
    })
  }, [lines, levelFilters, searchQuery])

  const toggleLevelFilter = useCallback((level: LogLevelFilter) => {
    setLevelFilters(prev => {
      const next = new Set(prev)
      if (level === 'all') {
        return new Set(['all'])
      }
      next.delete('all')
      if (next.has(level)) {
        next.delete(level)
      } else {
        next.add(level)
      }
      if (!next.size) {
        next.add('all')
      }
      return next
    })
  }, [])

  const hiddenCount = lines.length - filteredLines.length

  return {
    lines,
    phase,
    statusText,
    lineCount,
    fileSize,
    followTail,
    setFollowTail,
    searchQuery,
    setSearchQuery,
    levelFilters,
    toggleLevelFilter,
    filteredLines,
    hiddenCount,
    containerRef,
    onScroll,
    levelFilterOptions: LOG_LEVEL_FILTERS,
    atBottomRef,
  }
}

export type { LogLineCategory, ParsedLogLine }
