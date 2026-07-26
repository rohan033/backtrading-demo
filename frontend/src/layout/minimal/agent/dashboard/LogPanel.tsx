import { useState } from 'react'

import { formatRelativeTimestamp } from '@/lib/datetime'
import type { LogEntry } from './logModel'
import { ConfidenceBadge, Empty, Panel, agentGlyph } from './shared'

function LogRow({ entry }: { entry: LogEntry }) {
  const [open, setOpen] = useState(false)
  const hasBody = Boolean(entry.data && entry.data !== entry.oneline) || entry.confidence != null || entry.streaming
  const contentId = `ags-log-body-${entry.id}`

  return (
    <li className={`ags-log-item ags-log-item--${entry.kind} ags-log-item--tone-${entry.tone}`}>
      <button
        type="button"
        className="ags-log-row"
        aria-expanded={open}
        aria-controls={hasBody ? contentId : undefined}
        onClick={() => setOpen(value => !value)}
      >
        <span className={`ags-log-row__icon ags-log-row__icon--${entry.tone}`} aria-hidden>
          {entry.kind === 'thinking' ? '❋' : agentGlyph(entry.agent)}
        </span>
        <span className="ags-log-row__agent">{entry.agent}</span>
        {entry.ticker ? <span className="ags-log-row__ticker">{entry.ticker}</span> : null}
        <span className="ags-log-row__oneline">{entry.oneline}</span>
        {entry.streaming ? <span className="ags-log-row__live" aria-label="streaming">live</span> : null}
        <time className="ags-log-row__time" dateTime={entry.ts}>
          {formatRelativeTimestamp(entry.ts)}
        </time>
        {hasBody ? <span className={`ags-log-row__chev${open ? ' ags-log-row__chev--open' : ''}`} aria-hidden>▸</span> : null}
      </button>
      {open && hasBody ? (
        <div className="ags-log-body" id={contentId}>
          {entry.kind === 'thinking' ? (
            <pre className="ags-log-body__thinking">
              {entry.data || 'No thinking tokens captured.'}
              {entry.streaming ? <span className="ags-log-body__caret" aria-hidden>▍</span> : null}
            </pre>
          ) : (
            <p className="ags-log-body__data">{entry.data}</p>
          )}
          {entry.confidence != null ? (
            <div className="ags-log-body__foot">
              <span className="ags-log-body__foot-label">Confidence</span>
              <ConfidenceBadge value={entry.confidence} />
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

export default function LogPanel({
  title,
  entries,
  emptyText,
}: {
  title: string
  entries: LogEntry[]
  emptyText: string
}) {
  const streaming = entries.some(entry => entry.streaming)
  return (
    <Panel
      title={title}
      count={entries.length}
      className="ags-col-fill"
      bodyClassName="ags-log__body"
      actions={streaming ? <span className="ags-log__live-pill">streaming</span> : undefined}
    >
      {entries.length === 0 ? (
        <Empty>{emptyText}</Empty>
      ) : (
        <ul className="ags-log" aria-label="Session activity log">
          {entries.map(entry => (
            <LogRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </Panel>
  )
}
