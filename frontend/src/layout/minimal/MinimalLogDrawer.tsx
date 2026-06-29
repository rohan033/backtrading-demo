import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useLiveLogStream, type LiveLogTarget, type ParsedLogLine } from '../../hooks/useLiveLogStream'
import { categoryBadge } from '../../lib/logLineStyle'
import { formatLogMessage, hasLogJsonBody } from '../../lib/logJsonFormat'
import type { LogLevelFilter } from '../../lib/logFilters'
import './MinimalLogDrawer.css'

export type MinimalLogTarget = LiveLogTarget

const WIDTH_KEY = 'minimal-log-drawer-width'
const MIN_WIDTH = 320
const MAX_WIDTH = 720
const DEFAULT_WIDTH = 420

function loadWidth(): number {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY))
    if (Number.isFinite(value)) {
      return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value))
    }
  } catch {
    // ignore
  }
  return DEFAULT_WIDTH
}

function lineHighlightClass(line: ParsedLogLine): string {
  if (line.highlight === 'error') return 'mlog-line--error'
  if (line.highlight === 'warn') return 'mlog-line--warn'
  if (line.highlight === 'success') return 'mlog-line--success'
  return ''
}

function lineTextClass(category: ParsedLogLine['category']): string {
  return `mlog-line-text mlog-line-text--${category === 'info' ? 'default' : category}`
}

function badgeClass(category: ParsedLogLine['category']): string {
  return `mlog-badge mlog-badge--${category === 'info' ? 'default' : category}`
}

function filterClass(level: LogLevelFilter, active: boolean): string {
  const base = `mlog-filter${active ? ' mlog-filter--active' : ''}`
  if (level === 'all') return base
  return `${base} mlog-filter--${level}`
}

function phaseClass(phase: string): string {
  if (phase === 'live') return 'mlog-phase mlog-phase--live'
  if (phase === 'error') return 'mlog-phase mlog-phase--error'
  if (phase === 'waiting') return 'mlog-phase mlog-phase--waiting'
  return 'mlog-phase mlog-phase--loading'
}

function MinimalLogLineRow({ line }: { line: ParsedLogLine }) {
  const [prettified, setPrettified] = useState(false)
  const messageText = line.message || line.raw
  const canPrettify = useMemo(() => hasLogJsonBody(messageText), [messageText])
  const displayMessage = useMemo(
    () => formatLogMessage(messageText, prettified),
    [messageText, prettified],
  )

  return (
    <div
      className={`mlog-line ${lineHighlightClass(line)}`}
      style={{ paddingLeft: `${8 + line.indent * 10}px` }}
    >
      <span className={badgeClass(line.category)}>{categoryBadge(line.category)}</span>
      <div className="mlog-line-main">
        <div className={lineTextClass(line.category)}>
          {line.timestamp ? <span className="mlog-ts">{line.timestamp}</span> : null}
          <span>{displayMessage}</span>
        </div>
      </div>
      {canPrettify ? (
        <button
          type="button"
          className="mlog-json-btn"
          onClick={() => setPrettified(value => !value)}
          title={prettified ? 'Show compact JSON' : 'Prettify JSON body'}
        >
          {prettified ? 'Raw' : 'JSON'}
        </button>
      ) : null}
    </div>
  )
}

export default function MinimalLogDrawer({
  target,
  onClose,
  showBackdrop = true,
}: {
  target: MinimalLogTarget | null
  onClose: () => void
  showBackdrop?: boolean
}) {
  const [width, setWidth] = useState(loadWidth)
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const {
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
    levelFilterOptions,
    atBottomRef,
  } = useLiveLogStream(target)

  if (!target?.id) return null

  const strategyLinkId = target.executionId || target.id

  const startResize = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    resizeRef.current = { startX: event.clientX, startWidth: width }

    const onMove = (moveEvent: MouseEvent) => {
      const active = resizeRef.current
      if (!active) return
      const next = Math.min(
        MAX_WIDTH,
        Math.max(MIN_WIDTH, active.startWidth + active.startX - moveEvent.clientX),
      )
      setWidth(next)
    }

    const onUp = () => {
      resizeRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setWidth(current => {
        try {
          localStorage.setItem(WIDTH_KEY, String(current))
        } catch {
          // ignore
        }
        return current
      })
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return createPortal(
    <>
      {showBackdrop ? (
        <button
          type="button"
          className="mlog-backdrop"
          aria-label="Close live log drawer"
          onClick={onClose}
        />
      ) : null}

      <aside className="mlog-drawer" style={{ width, minWidth: width }}>
        <div
          className="mlog-drawer-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize log drawer"
          onMouseDown={startResize}
        />

        <header className="mlog-head">
          <div className="mlog-head-top">
            <div className="mlog-head-copy">
              <div className="mlog-kicker">Live log</div>
              <div className="mlog-title" title={target.label || target.id}>
                {target.label || target.id}
              </div>
              <div className="mlog-subtitle" title={strategyLinkId}>
                {strategyLinkId}
              </div>
              {target.logFile ? (
                <div className="mlog-file" title={target.logFile}>{target.logFile}</div>
              ) : null}
            </div>
            <button type="button" className="mlog-close" onClick={onClose}>
              Close
            </button>
          </div>

          <div className="mlog-meta">
            <span className={phaseClass(phase)}>{phase}</span>
            <span>{statusText}</span>
            <span>· {lineCount.toLocaleString()} lines</span>
            {fileSize ? <span>· {(fileSize / 1024).toFixed(1)} KB</span> : null}
            <button
              type="button"
              className={`mlog-tail-btn${followTail ? ' mlog-tail-btn--active' : ''}`}
              onClick={() => {
                setFollowTail(value => !value)
                atBottomRef.current = true
              }}
            >
              {followTail ? 'Following tail' : 'Tail paused'}
            </button>
          </div>

          <div className="mlog-controls">
            <input
              type="search"
              value={searchQuery}
              onChange={event => setSearchQuery(event.target.value)}
              placeholder="Fuzzy search logs…"
              className="mlog-search"
            />
            <div className="mlog-filters">
              {levelFilterOptions.map(level => (
                <button
                  key={level.id}
                  type="button"
                  className={filterClass(level.id, levelFilters.has(level.id))}
                  onClick={() => toggleLevelFilter(level.id)}
                >
                  {level.label}
                </button>
              ))}
            </div>
            {hiddenCount > 0 ? (
              <span className="mlog-filter-meta">
                Showing {filteredLines.length.toLocaleString()} of {lines.length.toLocaleString()} lines
              </span>
            ) : null}
          </div>
        </header>

        <div ref={containerRef} className="mlog-body" onScroll={onScroll}>
          {!lines.length && phase !== 'error' ? (
            <div className="mlog-empty">
              {phase === 'waiting' ? 'Waiting for the execution log file…' : 'Loading log output…'}
            </div>
          ) : null}

          {lines.length > 0 && filteredLines.length === 0 ? (
            <div className="mlog-empty">No log lines match the current filters.</div>
          ) : null}

          {filteredLines.map(line => (
            <MinimalLogLineRow key={line.id} line={line} />
          ))}

          {phase === 'error' ? (
            <div className="mlog-error">{statusText}</div>
          ) : null}
        </div>
      </aside>
    </>,
    document.body,
  )
}
