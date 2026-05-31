import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'

import DraggableWatchlistCard from '../../components/watchlist/DraggableWatchlistCard'
import WatchlistColumn from '../../components/watchlist/WatchlistColumn'
import { Button } from '../../components/ui/button'
import { useWatchlistTicks } from '../../hooks/useWatchlistTicks'
import type { WatchlistBroker } from '../../lib/watchlistBrokers'
import { defaultAccountEnv } from '../../lib/watchlistBrokers'
import {
  defaultLayout,
  loadWatchlistLayouts,
  mergeLayouts,
  saveWatchlistLayouts,
  type WatchlistCardLayout,
  type WatchlistLayoutMap,
} from '../../lib/watchlistLayout'
import { errorMessage } from '../../lib/apiError'
import {
  addWatchlistSymbol,
  createWatchlist,
  deleteWatchlist,
  fetchWatchlists,
  removeWatchlistSymbol,
  updateWatchlist,
  type Watchlist,
} from '../../lib/watchlists'

export default function WatchlistPage() {
  const [watchlists, setWatchlists] = useState<Watchlist[]>([])
  const [layouts, setLayouts] = useState<WatchlistLayoutMap>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const hasSymbols = watchlists.some(wl => wl.symbols.length > 0)
  const { ticks, connected } = useWatchlistTicks(watchlists, hasSymbols)

  const persistLayouts = useCallback((next: WatchlistLayoutMap) => {
    setLayouts(next)
    saveWatchlistLayouts(next)
  }, [])

  const load = useCallback(async () => {
    setError(null)
    try {
      const rows = await fetchWatchlists()
      setWatchlists(rows)
      const stored = loadWatchlistLayouts()
      persistLayouts(mergeLayouts(rows.map(r => r.id), stored))
    } catch (e) {
      setError(errorMessage(e, 'Failed to load watchlists'))
    } finally {
      setLoading(false)
    }
  }, [persistLayouts])

  useEffect(() => {
    load()
  }, [load])

  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const handleCreate = () =>
    wrap(async () => {
      const created = await createWatchlist(`Watchlist ${watchlists.length + 1}`, {
        broker: 'angel',
      })
      setWatchlists(prev => [...prev, created])
      persistLayouts({
        ...layouts,
        [created.id]: defaultLayout(watchlists.length),
      })
    })

  const handleRename = (id: string, name: string) =>
    wrap(async () => {
      const updated = await updateWatchlist(id, { name })
      setWatchlists(prev => prev.map(wl => (wl.id === id ? updated : wl)))
    })

  const handleBrokerChange = (id: string, broker: WatchlistBroker, accountEnv: string) =>
    wrap(async () => {
      const updated = await updateWatchlist(id, { broker, account_env: accountEnv })
      setWatchlists(prev => prev.map(wl => (wl.id === id ? updated : wl)))
    })

  const handleDelete = (id: string) =>
    wrap(async () => {
      await deleteWatchlist(id)
      setWatchlists(prev => prev.filter(wl => wl.id !== id))
      const next = { ...layouts }
      delete next[id]
      persistLayouts(next)
    })

  const handleAddSymbol = (
    watchlistId: string,
    hit: { symboltoken: string; tradingsymbol: string; exchange: string },
  ) =>
    wrap(async () => {
      const updated = await addWatchlistSymbol(watchlistId, hit)
      setWatchlists(prev => prev.map(wl => (wl.id === watchlistId ? updated : wl)))
    })

  const handleRemoveSymbol = (watchlistId: string, symboltoken: string) =>
    wrap(async () => {
      const updated = await removeWatchlistSymbol(watchlistId, symboltoken)
      setWatchlists(prev => prev.map(wl => (wl.id === watchlistId ? updated : wl)))
    })

  const handleLayoutChange = (id: string, next: WatchlistCardLayout) => {
    persistLayouts({ ...layouts, [id]: next })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
        <div>
          <h1 className="text-sm font-semibold">Watchlists</h1>
          <p className="mt-0.5 text-[11px] text-text-secondary">
            Drag cards anywhere · resize right/bottom edges or corner (2–12 row heights)
            {hasSymbols && (
              <span className="ml-2">{connected ? '· Live' : '· Connecting…'}</span>
            )}
          </p>
        </div>
        <Button type="button" size="sm" onClick={handleCreate} disabled={busy} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          New watchlist
        </Button>
      </div>

      {error && (
        <div className="mx-5 mt-3 flex items-start justify-between gap-3 rounded border border-red/30 bg-red/10 px-3 py-2 text-xs text-red">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="shrink-0 text-[10px] text-red/80 hover:text-red"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-auto bg-primary/30">
        {loading ? (
          <p className="p-5 text-xs text-text-secondary">Loading watchlists…</p>
        ) : watchlists.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <p className="text-sm text-text-secondary">No watchlists yet.</p>
            <Button type="button" onClick={handleCreate} disabled={busy} className="gap-1.5">
              <Plus className="h-4 w-4" />
              Create your first watchlist
            </Button>
          </div>
        ) : (
          <div className="relative min-h-[32rem] w-full min-w-[48rem] p-4">
            {watchlists.map(wl => {
              const layout = layouts[wl.id] ?? mergeLayouts([wl.id], {})[wl.id]
              return (
                <DraggableWatchlistCard
                  key={wl.id}
                  layout={layout}
                  onLayoutChange={next => handleLayoutChange(wl.id, next)}
                >
                  <WatchlistColumn
                    watchlist={{
                      ...wl,
                      broker: (wl.broker || 'angel') as WatchlistBroker,
                      account_env: wl.account_env || defaultAccountEnv((wl.broker || 'angel') as WatchlistBroker),
                    }}
                    layout={layout}
                    ticks={ticks}
                    onRename={handleRename}
                    onDelete={handleDelete}
                    onBrokerChange={handleBrokerChange}
                    onAddSymbol={handleAddSymbol}
                    onRemoveSymbol={handleRemoveSymbol}
                  />
                </DraggableWatchlistCard>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
