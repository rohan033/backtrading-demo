import { useEffect, useRef, useState } from 'react'
import { Pencil, Plus, X } from 'lucide-react'

import type { WatchlistPanel } from '../../lib/watchlists'

type Props = {
  panels: WatchlistPanel[]
  activePanelId: string | null
  busy?: boolean
  onSelect: (panelId: string) => void
  onCreate: () => void
  onRename: (panelId: string, name: string) => void
  onDelete: (panelId: string) => void
}

export default function WatchlistPanelTabs({
  panels,
  activePanelId,
  busy = false,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingId) inputRef.current?.focus()
  }, [editingId])

  const startEdit = (panel: WatchlistPanel) => {
    setEditingId(panel.id)
    setNameDraft(panel.name)
  }

  const commitEdit = () => {
    if (!editingId) return
    const trimmed = nameDraft.trim()
    setEditingId(null)
    if (trimmed) onRename(editingId, trimmed)
  }

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-secondary/20 px-5 py-2" data-no-drag>
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {panels.map(panel => {
          const active = panel.id === activePanelId
          const editing = editingId === panel.id
          return (
            <div
              key={panel.id}
              className={`group inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 transition-colors ${
                active
                  ? 'border-accent/40 bg-accent/10 text-accent'
                  : 'border-border/60 bg-card/40 text-text-secondary hover:border-border hover:text-text-primary'
              }`}
            >
              {editing ? (
                <input
                  ref={inputRef}
                  value={nameDraft}
                  onChange={e => setNameDraft(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitEdit()
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  className="w-24 rounded border border-border bg-primary px-1.5 py-0.5 text-[11px] font-semibold text-text-primary outline-none focus:border-accent/50"
                />
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onSelect(panel.id)}
                  onDoubleClick={() => startEdit(panel)}
                  className="max-w-[9rem] truncate text-[11px] font-semibold"
                  title={`${panel.name} · ${panel.watchlist_count ?? 0} watchlist(s)`}
                >
                  {panel.name}
                  {(panel.watchlist_count ?? 0) > 0 ? (
                    <span className="ml-1 text-[10px] font-medium opacity-70">{panel.watchlist_count}</span>
                  ) : null}
                </button>
              )}
              {!editing ? (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => startEdit(panel)}
                    className="rounded p-0.5 opacity-0 transition-opacity hover:bg-card-hi group-hover:opacity-100"
                    title="Rename panel"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  {panels.length > 1 ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onDelete(panel.id)}
                      className="rounded p-0.5 opacity-0 transition-opacity hover:bg-red/10 hover:text-red group-hover:opacity-100"
                      title="Delete panel"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
          )
        })}
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={onCreate}
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:border-accent/40 hover:text-text-primary"
        title="Create panel"
      >
        <Plus className="h-3.5 w-3.5" />
        Panel
      </button>
    </div>
  )
}
