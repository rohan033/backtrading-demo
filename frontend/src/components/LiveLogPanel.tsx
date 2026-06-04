import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { X } from 'lucide-react'

import {
  categoryBadge,
  categoryBadgeClass,
  parseLogLine,
  type LogLineCategory,
  type ParsedLogLine,
} from '../lib/logLineStyle'
import { formatLogMessage, hasLogJsonBody } from '../lib/logJsonFormat'
import {
  fuzzyMatchLog,
  LOG_LEVEL_FILTERS,
  matchesLogLevelFilter,
  type LogLevelFilter,
} from '../lib/logFilters'

const MAX_RENDERED_LINES = 2500
const BATCH_FRAME_LINES = 120

type LogPanelTarget = {
  id: string
  label: string
  logFile?: string | null
  isControlled?: boolean
}

type StreamPhase = 'idle' | 'waiting' | 'loading' | 'live' | 'error'

function LogLineRow({ line }: { line: ParsedLogLine }) {
  const [prettified, setPrettified] = useState(false)
  const messageText = line.message || line.raw
  const canPrettify = useMemo(() => hasLogJsonBody(messageText), [messageText])
  const displayMessage = useMemo(
    () => formatLogMessage(messageText, prettified),
    [messageText, prettified],
  )

  return (
    <div
      className={`group flex gap-2 border-b border-border/30 px-3 py-1.5 ${line.rowClassName}`}
      style={{ paddingLeft: `${12 + line.indent * 12}px` }}
    >
      <span
        className={`mt-0.5 inline-flex h-4 min-w-[2rem] shrink-0 items-center justify-center rounded px-1 text-[9px] font-bold tracking-wide ${categoryBadgeClass(line.category)}`}
      >
        {categoryBadge(line.category)}
      </span>
      <div className="min-w-0 flex-1">
        <div className={`font-mono text-[11px] leading-5 whitespace-pre-wrap break-all ${line.className}`}>
          {line.timestamp ? (
            <span className="mr-2 text-text-secondary/60">{line.timestamp}</span>
          ) : null}
          <span>{displayMessage}</span>
        </div>
      </div>
      {canPrettify ? (
        <button
          type="button"
          onClick={() => setPrettified(value => !value)}
          className="mt-0.5 shrink-0 self-start rounded border border-border/70 bg-card/80 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-text-secondary hover:text-text-primary"
          title={prettified ? 'Show compact JSON' : 'Prettify JSON body'}
        >
          {prettified ? 'Raw' : 'JSON'}
        </button>
      ) : null}
    </div>
  )
}

export default function LiveLogPanel({
  target,
  onClose,
}: {
  target: LogPanelTarget
  onClose: () => void
}) {
  const [lines, setLines] = useState<ParsedLogLine[]>([])
  const [phase, setPhase] = useState<StreamPhase>('idle')
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

  const flushPendingLines = useCallback(() => {
    flushFrameRef.current = null
    if (!pendingLinesRef.current.length) return

    const batch = pendingLinesRef.current.splice(0, BATCH_FRAME_LINES)
    setLines(prev => {
      const parsed = batch.map(line => {
        const entry = parseLogLine(line, lineIndexRef.current)
        lineIndexRef.current += 1
        return { ...entry, id: `${target.id}-${entry.id}` }
      })
      const next = [...prev, ...parsed]
      return next.length > MAX_RENDERED_LINES ? next.slice(-MAX_RENDERED_LINES) : next
    })

    if (pendingLinesRef.current.length) {
      flushFrameRef.current = window.requestAnimationFrame(flushPendingLines)
    }
  }, [target.id])

  const enqueueLines = useCallback((incoming: string[]) => {
    if (!incoming.length) return
    pendingLinesRef.current.push(...incoming)
    if (flushFrameRef.current == null) {
      flushFrameRef.current = window.requestAnimationFrame(flushPendingLines)
    }
  }, [flushPendingLines, target.id])

  useEffect(() => {
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
  }, [target.id, enqueueLines])

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

  const toggleLevelFilter = (level: LogLevelFilter) => {
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
  }

  const hiddenCount = lines.length - filteredLines.length

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-xl flex-col border-l border-border bg-secondary shadow-2xl">
      <div className="border-b border-border px-4 py-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[1.5px] text-text-secondary">Live log</div>
            <div className="mt-1 truncate text-sm font-semibold">{target.label || target.id}</div>
            {target.isControlled ? (
              <Link
                to={`/trade/strategies/${encodeURIComponent(target.id)}`}
                className="mt-1 block truncate font-mono text-[10px] text-accent hover:underline"
              >
                {target.id}
              </Link>
            ) : (
              <div className="mt-1 truncate font-mono text-[10px] text-text-secondary">{target.id}</div>
            )}
            {target.logFile ? (
              <div className="mt-1 truncate font-mono text-[9px] text-text-secondary" title={target.logFile}>
                {target.logFile}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border bg-card p-2 text-text-secondary hover:text-text-primary"
            aria-label="Close live log panel"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px]">
          <span className={`rounded-full px-2 py-0.5 font-bold uppercase tracking-wide ${
            phase === 'live'
              ? 'bg-green/15 text-green'
              : phase === 'error'
                ? 'bg-red/15 text-red'
                : phase === 'waiting'
                  ? 'bg-amber-400/15 text-amber-400'
                  : 'bg-accent/15 text-accent'
          }`}>
            {phase}
          </span>
          <span className="text-text-secondary">{statusText}</span>
          <span className="text-text-secondary">· {lineCount.toLocaleString()} lines</span>
          {fileSize ? (
            <span className="text-text-secondary">· {(fileSize / 1024).toFixed(1)} KB</span>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setFollowTail(value => !value)
              atBottomRef.current = true
            }}
            className={`ml-auto rounded border px-2 py-0.5 font-semibold ${
              followTail ? 'border-green/40 text-green' : 'border-border text-text-secondary'
            }`}
          >
            {followTail ? 'Following tail' : 'Tail paused'}
          </button>
        </div>

        <div className="mt-3 flex flex-col gap-2">
          <input
            type="search"
            value={searchQuery}
            onChange={event => setSearchQuery(event.target.value)}
            placeholder="Fuzzy search logs…"
            className="w-full rounded-lg border border-border bg-primary px-2.5 py-1.5 text-[11px] text-text-primary outline-none placeholder:text-text-secondary focus:border-accent/60"
          />
          <div className="flex flex-wrap gap-1">
            {LOG_LEVEL_FILTERS.map(level => {
              const active = levelFilters.has(level.id)
              return (
                <button
                  key={level.id}
                  type="button"
                  onClick={() => toggleLevelFilter(level.id)}
                  className={`rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide transition-colors ${
                    active
                      ? level.id === 'all'
                        ? 'border-accent/50 bg-accent/15 text-accent'
                        : `${categoryBadgeClass(level.id as LogLineCategory)} border-transparent`
                      : 'border-border/60 bg-card/50 text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {level.label}
                </button>
              )
            })}
          </div>
          {hiddenCount > 0 ? (
            <span className="text-[10px] text-text-secondary">
              Showing {filteredLines.length.toLocaleString()} of {lines.length.toLocaleString()} lines
            </span>
          ) : null}
        </div>
      </div>

      <div
        ref={containerRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto bg-[#0b1016]"
      >
        {!lines.length && phase !== 'error' ? (
          <div className="px-4 py-10 text-center text-sm text-text-secondary">
            {phase === 'waiting' ? 'Waiting for the execution log file…' : 'Loading log output…'}
          </div>
        ) : null}

        {lines.length > 0 && filteredLines.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-text-secondary">
            No log lines match the current filters.
          </div>
        ) : null}

        {filteredLines.map(line => (
          <LogLineRow key={line.id} line={line} />
        ))}

        {phase === 'error' ? (
          <div className="px-4 py-6 text-sm text-red">{statusText}</div>
        ) : null}
      </div>
    </aside>
  )
}
