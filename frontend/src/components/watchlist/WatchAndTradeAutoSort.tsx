import { useEffect } from 'react'

import {
  saveWatchlistAutoSortConfig,
  type WatchlistAutoSortConfig,
} from '../../lib/watchlistAutoSort'
import { WATCHLIST_CHANGE_WINDOWS } from '../../lib/watchlistChangeColumns'

type Props = {
  config: WatchlistAutoSortConfig
  onChange: (config: WatchlistAutoSortConfig) => void
}

export default function WatchAndTradeAutoSort({ config, onChange }: Props) {
  useEffect(() => {
    saveWatchlistAutoSortConfig(config)
  }, [config])

  return (
    <div className={`wt-sort-control${config.enabled ? ' wt-sort-control--on' : ''}`}>
      <button
        type="button"
        className="wt-sort-toggle"
        title={config.enabled ? 'Auto-sort on — click to disable' : 'Enable auto-sort by % change'}
        onClick={() => onChange({ ...config, enabled: !config.enabled })}
      >
        Sort
      </button>
      <select
        className="wt-sort-select"
        value={config.column}
        onChange={event =>
          onChange({
            ...config,
            column: event.target.value as WatchlistAutoSortConfig['column'],
          })
        }
        title="Sort column"
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
