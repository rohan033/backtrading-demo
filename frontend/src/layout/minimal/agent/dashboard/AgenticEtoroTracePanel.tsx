import { useMemo, useState } from 'react'

import { useLiveLogStream } from '@/hooks/useLiveLogStream'
import { formatLogMessage, hasLogJsonBody } from '@/lib/logJsonFormat'
import { Panel } from './shared'

function TraceLine({ raw }: { raw: string }) {
  const [prettified, setPrettified] = useState(true)
  const canPrettify = useMemo(() => hasLogJsonBody(raw), [raw])
  const display = useMemo(
    () => formatLogMessage(raw, prettified && canPrettify),
    [raw, prettified, canPrettify],
  )

  let summary = ''
  try {
    const parsed = JSON.parse(raw.trim()) as {
      ts?: string
      request?: { method?: string; path?: string }
      source?: string
      ticker?: string
      duration_ms?: number
      response?: { error?: string }
    }
    const method = parsed.request?.method || '?'
    const path = parsed.request?.path || ''
    summary = `${method} ${path}`
    if (parsed.ticker) summary += ` · ${parsed.ticker}`
    if (parsed.source) summary += ` · ${parsed.source}`
    if (parsed.duration_ms != null) summary += ` · ${parsed.duration_ms}ms`
    if (parsed.response?.error) summary += ' · ERROR'
  } catch {
    summary = raw.slice(0, 120)
  }

  return (
    <li className="ags-etoro-trace-line">
      <details className="ags-etoro-trace-line__details">
        <summary className="ags-etoro-trace-line__summary">{summary}</summary>
        <div className="ags-etoro-trace-line__body-wrap">
          {canPrettify ? (
            <button
              type="button"
              className="ags-etoro-trace-line__toggle"
              onClick={event => {
                event.preventDefault()
                setPrettified(value => !value)
              }}
            >
              {prettified ? 'Raw' : 'JSON'}
            </button>
          ) : null}
          <pre className="ags-etoro-trace-line__body">{display}</pre>
        </div>
      </details>
    </li>
  )
}

export default function AgenticEtoroTracePanel({ sessionId }: { sessionId: string }) {
  const target = useMemo(
    () => ({
      id: sessionId,
      label: 'eToro API trace',
      streamPath: `/api/agentic/sessions/${encodeURIComponent(sessionId)}/etoro-logs/stream`,
    }),
    [sessionId],
  )

  const {
    filteredLines,
    phase,
    statusText,
    lineCount,
    fileSize,
    followTail,
    setFollowTail,
    searchQuery,
    setSearchQuery,
    containerRef,
    onScroll,
  } = useLiveLogStream(target)

  return (
    <Panel
      title="eToro API trace"
      bodyClassName="ags-etoro-trace__body"
      actions={(
        <span className={`ags-etoro-trace__phase ags-etoro-trace__phase--${phase}`}>
          {phase}
        </span>
      )}
    >
      <div className="ags-etoro-trace__toolbar">
        <input
          type="search"
          className="ags-etoro-trace__search"
          value={searchQuery}
          onChange={event => setSearchQuery(event.target.value)}
          placeholder="Filter requests…"
          aria-label="Filter eToro trace"
        />
        <button
          type="button"
          className={`ags-etoro-trace__tail${followTail ? ' ags-etoro-trace__tail--on' : ''}`}
          onClick={() => setFollowTail(value => !value)}
        >
          {followTail ? 'Tail on' : 'Tail off'}
        </button>
      </div>
      <p className="ags-etoro-trace__meta">
        {statusText}
        {lineCount ? ` · ${lineCount.toLocaleString()} lines` : ''}
        {fileSize ? ` · ${(fileSize / 1024).toFixed(1)} KB` : ''}
      </p>
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="ags-etoro-trace__scroll"
        aria-label="eToro API trace log"
      >
        {filteredLines.length === 0 ? (
          <p className="ags-etoro-trace__empty">
            {phase === 'waiting' || phase === 'loading'
              ? 'Waiting for eToro API calls from this session…'
              : 'No trace lines match the filter.'}
          </p>
        ) : (
          <ul className="ags-etoro-trace-list">
            {filteredLines.map(line => (
              <TraceLine key={line.id} raw={line.raw} />
            ))}
          </ul>
        )}
      </div>
    </Panel>
  )
}
