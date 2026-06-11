import { ArrowDownWideNarrow } from 'lucide-react'
import { useEffect } from 'react'

import { saveWatchlistAutoSortConfig, type WatchlistAutoSortConfig } from '../../lib/watchlistAutoSort'
import { WATCHLIST_CHANGE_WINDOWS } from '../../lib/watchlistChangeColumns'

type Props = {
  config: WatchlistAutoSortConfig
  onChange: (config: WatchlistAutoSortConfig) => void
}

export default function WatchlistAutoSort({ config, onChange }: Props) {
  useEffect(() => {
    saveWatchlistAutoSortConfig(config)
  }, [config])

  const columnLabel =
    WATCHLIST_CHANGE_WINDOWS.find(window => window.id === config.column)?.label ?? config.column

  return (
    <div
      className={`inline-flex items-center overflow-hidden rounded-md border transition-colors ${
        config.enabled
          ? 'border-accent/40 bg-accent/10'
          : 'border-border bg-card'
      }`}
      data-no-drag
    >
      <button
        type="button"
        onClick={() => onChange({ ...config, enabled: !config.enabled })}
        title={
          config.enabled
            ? `Auto-sort on · ${columnLabel} descending · click to disable`
            : 'Enable auto-sort by % change'
        }
        className={`inline-flex h-[30px] items-center gap-1.5 border-r px-2.5 text-[11px] font-medium transition-colors ${
          config.enabled
            ? 'border-accent/30 text-accent'
            : 'border-border text-text-secondary hover:text-text-primary'
        }`}
      >
        <ArrowDownWideNarrow className="h-3.5 w-3.5" />
        Sort
      </button>
      <select
        value={config.column}
        onChange={event =>
          onChange({
            ...config,
            column: event.target.value as WatchlistAutoSortConfig['column'],
          })
        }
        title="Sort column"
        className={`h-[30px] cursor-pointer border-0 bg-transparent px-2 pr-6 text-[11px] font-semibold outline-none ${
          config.enabled ? 'text-accent' : 'text-text-primary'
        }`}
      >
        {WATCHLIST_CHANGE_WINDOWS.map(window => (
          <option key={window.id} value={window.id}>
            {window.label}
          </option>
        ))}
      </select>
    </div>
  )
}
