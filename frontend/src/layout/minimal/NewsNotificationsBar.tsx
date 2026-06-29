import { useEffect, useMemo, useRef, useState } from 'react'

import type { NewsUpdateGroup } from '../../hooks/useNewsNotifications'
import './NewsNotificationsBar.css'

type Props = {
  groups: NewsUpdateGroup[]
  onClear: () => void
  onOpenPanel?: () => void
  clearing?: boolean
  clearError?: string
}

export default function NewsNotificationsBar({
  groups,
  onClear,
  onOpenPanel,
  clearing = false,
  clearError = '',
}: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const totalCount = useMemo(
    () => groups.reduce((sum, group) => sum + group.count, 0),
    [groups],
  )
  const latest = groups[0]?.latest
  const hasMultiple = totalCount > 1

  useEffect(() => {
    if (!open) return undefined
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open])

  useEffect(() => {
    if (!groups.length) setOpen(false)
  }, [groups.length])

  if (!groups.length || !latest) return null

  const handleClear = () => {
    onClear()
    setOpen(false)
  }

  return (
    <div className="ms-news-bar" ref={rootRef}>
      {hasMultiple ? (
        <>
          <button
            type="button"
            className="ms-news-bar__trigger"
            aria-expanded={open}
            aria-haspopup="menu"
            onClick={() => setOpen(prev => !prev)}
          >
            <span className="ms-news-bar__topic">{latest.topic}</span>
            <span className="ms-news-bar__headline">{latest.headline}</span>
            <span className="ms-news-bar__badge">+{totalCount - 1}</span>
            <span className="ms-news-bar__chevron" aria-hidden="true">{open ? '▴' : '▾'}</span>
          </button>
          {open ? (
            <div className="ms-news-bar__menu" role="menu">
              <div className="ms-news-bar__menu-head">
                <span>{totalCount} news update{totalCount === 1 ? '' : 's'}</span>
                <button
                  type="button"
                  className="ms-news-bar__clear"
                  disabled={clearing}
                  onClick={handleClear}
                >
                  {clearing ? 'Clearing…' : 'Clear all'}
                </button>
              </div>
              {clearError ? <div className="ms-news-bar__error">{clearError}</div> : null}
              <div className="ms-news-bar__menu-body">
                {groups.map(group => (
                  <section key={group.topic} className="ms-news-bar__group">
                    <div className="ms-news-bar__group-head">
                      <strong>{group.topic}</strong>
                      <span>+{group.count}</span>
                    </div>
                    <ul>
                      {group.items.map(item => (
                        <li key={item.id}>
                          <a href={item.url || '#'} target="_blank" rel="noopener noreferrer">
                            <span>{item.headline}</span>
                            {item.source ? <em>{item.source}</em> : null}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
              {onOpenPanel ? (
                <button
                  type="button"
                  className="ms-news-bar__panel-link"
                  onClick={() => {
                    setOpen(false)
                    onOpenPanel()
                  }}
                >
                  Open News Updates panel
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <div className="ms-news-bar__single">
          <span className="ms-news-bar__topic">{latest.topic}</span>
          <a
            className="ms-news-bar__headline ms-news-bar__headline--link"
            href={latest.url || '#'}
            target="_blank"
            rel="noopener noreferrer"
          >
            {latest.headline}
          </a>
          <button
            type="button"
            className="ms-news-bar__clear ms-news-bar__clear--inline"
            disabled={clearing}
            onClick={handleClear}
            aria-label="Clear news update"
          >
            {clearing ? '…' : 'Clear'}
          </button>
        </div>
      )}
    </div>
  )
}
