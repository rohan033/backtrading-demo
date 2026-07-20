import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  createScreener,
  deleteScreener,
  fetchScreener,
  fetchScreenerFields,
  fetchScreeners,
  refreshScreener,
  syncScreenerWatchlist,
  updateScreener,
  validateScreenerDsl,
  type Screener,
  type ScreenerDefinition,
  type ScreenerField,
  type ScreenerFilterCond,
  type WatchlistSyncSummary,
} from '../../lib/screenerApi'
import {
  definitionToDsl,
  emptyDefinition,
  formatScreenerNumber,
  tickerSymbol,
} from '../../lib/screenerDefinition'
import { showPlatformToast } from '../../lib/platform-toast'
import './Screener.css'

type EditorMode = 'filters' | 'dsl'
type SortState = { key: string; dir: 'asc' | 'desc' } | null
type RowSyncStatus = Record<string, 'adding' | 'added' | 'already_present' | 'unmatched' | 'failed'>

const PAGE_SIZES = [10, 20, 50] as const
const PERCENT_KEYS = new Set([
  'change',
  'premarket_change',
  'premarket_gap',
  'postmarket_change',
  'gap',
  'Perf.W',
  'Perf.1M',
  'Perf.3M',
  'Perf.6M',
  'Perf.Y',
  'Perf.YTD',
  'Perf.1Y.MarketCap',
  'dividends_yield_current',
])
const PRICE_KEYS = new Set([
  'close',
  'open',
  'high',
  'low',
  'premarket_close',
  'premarket_change_abs',
  'change_abs',
  'SMA20',
  'SMA50',
  'SMA200',
  'EMA20',
  'EMA50',
  'EMA200',
  'VWAP',
])

const COLUMN_LABELS: Record<string, string> = {
  ticker: 'Symbol',
  name: 'Symbol',
  close: 'Price',
  change: 'Chg %',
  volume: 'Vol',
  market_cap_basic: 'Mkt cap',
  'Perf.1Y.MarketCap': 'Mkt cap perf % 1Y',
  premarket_change: 'Pre-mkt chg %',
  premarket_close: 'Pre-mkt price',
  premarket_change_abs: 'Pre-mkt chg',
  premarket_volume: 'Pre-mkt vol',
  premarket_gap: 'Pre-mkt gap %',
}

function cellKind(key: string): 'percent' | 'price' | 'number' {
  if (PERCENT_KEYS.has(key)) return 'percent'
  if (PRICE_KEYS.has(key)) return 'price'
  return 'number'
}

function changeClass(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n === 0) return 'scr-chg--flat'
  return n > 0 ? 'scr-chg--up' : 'scr-chg--down'
}

function statusClass(status: string): string {
  if (status === 'ok') return 'scr-status--ok'
  if (status === 'running') return 'scr-status--running'
  if (status === 'error') return 'scr-status--error'
  return 'scr-status--idle'
}

function formatTime(iso?: string | null): string {
  if (!iso) return 'never'
  try {
    return new Date(iso).toLocaleTimeString()
  } catch {
    return iso
  }
}

function defaultFilter(): ScreenerFilterCond {
  return { left: 'premarket_change', operation: 'greater', right: 5 }
}

export default function ScreenerPage() {
  const [screeners, setScreeners] = useState<Screener[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [screener, setScreener] = useState<Screener | null>(null)
  const [fields, setFields] = useState<ScreenerField[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [editorOpen, setEditorOpen] = useState(true)
  const [editorMode, setEditorMode] = useState<EditorMode>('filters')
  const [draftDefinition, setDraftDefinition] = useState<ScreenerDefinition>(emptyDefinition())
  const [draftDsl, setDraftDsl] = useState('')
  const [dslError, setDslError] = useState('')
  const [saving, setSaving] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [autoInterval, setAutoInterval] = useState(60)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(20)
  const [sort, setSort] = useState<SortState>(null)
  const [rowStatus, setRowStatus] = useState<RowSyncStatus>({})
  const [syncingBulk, setSyncingBulk] = useState(false)
  const [lastSummary, setLastSummary] = useState<WatchlistSyncSummary | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)
  const refreshInFlight = useRef(false)
  const visibleRef = useRef(typeof document !== 'undefined' ? document.visibilityState === 'visible' : true)

  const selected = screener

  useEffect(() => {
    if (editingId) nameInputRef.current?.focus()
  }, [editingId])

  const startRename = (item: Screener) => {
    setEditingId(item.id)
    setNameDraft(item.name)
  }

  const commitRename = async () => {
    if (!editingId) return
    const trimmed = nameDraft.trim()
    const id = editingId
    setEditingId(null)
    const current = screeners.find(s => s.id === id)
    if (!trimmed || !current || trimmed === current.name) return
    try {
      const updated = await updateScreener(id, { name: trimmed })
      setScreener(prev => (prev?.id === id ? { ...prev, name: updated.name } : prev))
      setScreeners(prev => prev.map(s => (s.id === updated.id ? { ...s, name: updated.name } : s)))
    } catch (err) {
      showPlatformToast({
        variant: 'error',
        message: err instanceof Error ? err.message : 'Rename failed',
      })
    }
  }

  const loadList = useCallback(async (preferId?: string | null) => {
    setLoading(true)
    setError('')
    try {
      const [list, fieldList] = await Promise.all([fetchScreeners(false), fetchScreenerFields()])
      setScreeners(list)
      setFields(fieldList)
      const nextId = preferId || selectedId || list[0]?.id || null
      setSelectedId(nextId)
      if (nextId) {
        const full = await fetchScreener(nextId)
        setScreener(full)
        setDraftDefinition(full.definition || emptyDefinition())
        setDraftDsl(full.dsl_text || definitionToDsl(full.definition || emptyDefinition()))
        setAutoRefresh(Boolean(full.auto_refresh_seconds && full.auto_refresh_seconds > 0))
        setAutoInterval(full.auto_refresh_seconds > 0 ? full.auto_refresh_seconds : 60)
      } else {
        setScreener(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load screeners')
    } finally {
      setLoading(false)
    }
  }, [selectedId])

  useEffect(() => {
    void loadList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectScreener = async (id: string) => {
    setSelectedId(id)
    setPage(1)
    setSort(null)
    setRowStatus({})
    setLastSummary(null)
    setError('')
    try {
      const full = await fetchScreener(id)
      setScreener(full)
      setDraftDefinition(full.definition || emptyDefinition())
      setDraftDsl(full.dsl_text || definitionToDsl(full.definition || emptyDefinition()))
      setAutoRefresh(Boolean(full.auto_refresh_seconds && full.auto_refresh_seconds > 0))
      setAutoInterval(full.auto_refresh_seconds > 0 ? full.auto_refresh_seconds : 60)
      setDslError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load screener')
    }
  }

  const doRefresh = useCallback(async () => {
    if (!selectedId || refreshInFlight.current) return
    refreshInFlight.current = true
    setRefreshing(true)
    setError('')
    try {
      const updated = await refreshScreener(selectedId)
      setScreener(updated)
      setScreeners(prev => prev.map(s => (s.id === updated.id ? { ...s, ...updated, results: [] } : s)))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Refresh failed'
      setError(message)
      // Keep previous results; re-fetch to pick up error status
      try {
        const latest = await fetchScreener(selectedId)
        setScreener(latest)
      } catch {
        /* ignore */
      }
    } finally {
      refreshInFlight.current = false
      setRefreshing(false)
    }
  }, [selectedId])

  useEffect(() => {
    const onVis = () => {
      visibleRef.current = document.visibilityState === 'visible'
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  useEffect(() => {
    if (!autoRefresh || !selectedId) return
    const ms = Math.max(15, autoInterval) * 1000
    const timer = window.setInterval(() => {
      if (!visibleRef.current) return
      void doRefresh()
    }, ms)
    return () => window.clearInterval(timer)
  }, [autoRefresh, autoInterval, selectedId, doRefresh])

  const persistAutoRefresh = async (enabled: boolean, seconds: number) => {
    if (!selectedId) return
    setAutoRefresh(enabled)
    setAutoInterval(seconds)
    try {
      const updated = await updateScreener(selectedId, {
        auto_refresh_seconds: enabled ? seconds : 0,
      })
      setScreener(prev => (prev ? { ...prev, auto_refresh_seconds: updated.auto_refresh_seconds } : prev))
    } catch (err) {
      showPlatformToast({
        variant: 'error',
        message: err instanceof Error ? err.message : 'Failed to save auto-refresh',
      })
    }
  }

  const columnLabel = (key: string) => {
    const fromFields = fields.find(f => f.key === key)?.label
    return fromFields || COLUMN_LABELS[key] || key
  }

  const columns = useMemo(() => {
    const defCols = selected?.definition?.columns || draftDefinition.columns || []
    const ordered: string[] = ['ticker']
    for (const col of defCols) {
      if (col === 'ticker' || col === 'name') continue
      if (!ordered.includes(col)) ordered.push(col)
    }
    return ordered.length > 1
      ? ordered
      : ['ticker', 'close', 'premarket_change', 'premarket_volume', 'market_cap_basic']
  }, [selected, draftDefinition])

  const sortedRows = useMemo(() => {
    const rows = [...(selected?.results || [])]
    if (!sort) return rows
    const { key, dir } = sort
    rows.sort((a, b) => {
      const av = key === 'ticker' ? a.ticker : a.cells?.[key]
      const bv = key === 'ticker' ? b.ticker : b.cells?.[key]
      const an = typeof av === 'number' ? av : Number(av)
      const bn = typeof bv === 'number' ? bv : Number(bv)
      let cmp = 0
      if (Number.isFinite(an) && Number.isFinite(bn)) cmp = an - bn
      else cmp = String(av ?? '').localeCompare(String(bv ?? ''))
      return dir === 'asc' ? cmp : -cmp
    })
    return rows
  }, [selected, sort])

  const pageCount = Math.max(1, Math.ceil(sortedRows.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const pagedRows = useMemo(() => {
    const start = (currentPage - 1) * pageSize
    return sortedRows.slice(start, start + pageSize)
  }, [sortedRows, currentPage, pageSize])

  useEffect(() => {
    if (page > pageCount) setPage(pageCount)
  }, [page, pageCount])

  const toggleSort = (key: string) => {
    setSort(prev => {
      if (!prev || prev.key !== key) return { key, dir: 'desc' }
      if (prev.dir === 'desc') return { key, dir: 'asc' }
      return null
    })
  }

  const updateDraftFilters = (filters: ScreenerFilterCond[]) => {
    const next = { ...draftDefinition, filters }
    setDraftDefinition(next)
    setDraftDsl(definitionToDsl(next))
    setDslError('')
  }

  const saveDefinition = async () => {
    if (!selectedId) return
    setSaving(true)
    setDslError('')
    try {
      let payload: { definition?: ScreenerDefinition; dsl_text?: string }
      if (editorMode === 'dsl') {
        const validated = await validateScreenerDsl(draftDsl)
        setDraftDefinition(validated.definition)
        setDraftDsl(validated.dsl_text)
        payload = { dsl_text: validated.dsl_text }
      } else {
        payload = { definition: draftDefinition }
        setDraftDsl(definitionToDsl(draftDefinition))
      }
      const updated = await updateScreener(selectedId, payload)
      setScreener(updated)
      setDraftDefinition(updated.definition)
      setDraftDsl(updated.dsl_text)
      setScreeners(prev => prev.map(s => (s.id === updated.id ? { ...s, name: updated.name } : s)))
      showPlatformToast({ variant: 'success', message: 'Screener saved' })
      await doRefresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Save failed'
      setDslError(message)
      showPlatformToast({ variant: 'error', message })
    } finally {
      setSaving(false)
    }
  }

  const handleCreate = async () => {
    try {
      const created = await createScreener({
        name: `Screener ${screeners.length + 1}`,
        definition: emptyDefinition(),
      })
      setScreeners(prev => [...prev, created])
      await selectScreener(created.id)
      setEditorOpen(true)
      setEditingId(created.id)
      setNameDraft(created.name)
    } catch (err) {
      showPlatformToast({
        variant: 'error',
        message: err instanceof Error ? err.message : 'Create failed',
      })
    }
  }

  const handleDelete = async (id?: string) => {
    const targetId = id || selected?.id
    if (!targetId) return
    const target = screeners.find(s => s.id === targetId)
    if (!target) return
    try {
      await deleteScreener(targetId)
      const remaining = screeners.filter(s => s.id !== targetId)
      setScreeners(remaining)
      if (editingId === targetId) setEditingId(null)
      if (selectedId === targetId) {
        if (remaining[0]) await selectScreener(remaining[0].id)
        else {
          setSelectedId(null)
          setScreener(null)
        }
      }
    } catch (err) {
      showPlatformToast({
        variant: 'error',
        message: err instanceof Error ? err.message : 'Delete failed',
      })
    }
  }

  const addRowToWatchlist = async (ticker: string) => {
    if (!selectedId) return
    setRowStatus(prev => ({ ...prev, [ticker]: 'adding' }))
    try {
      const { screener: updated, summary } = await syncScreenerWatchlist(selectedId, {
        tickers: [ticker],
        account_env: 'demo',
      })
      setScreener(updated)
      setLastSummary(summary)
      const item = summary.items[0]
      setRowStatus(prev => ({
        ...prev,
        [ticker]: (item?.status as RowSyncStatus[string]) || 'unmatched',
      }))
      if (item?.status === 'added' || item?.status === 'already_present') {
        showPlatformToast({
          variant: 'success',
          message: `${tickerSymbol(ticker)} → ${summary.watchlist_name}`,
        })
      } else {
        showPlatformToast({
          variant: 'error',
          message: `${tickerSymbol(ticker)} not available on eToro`,
        })
      }
    } catch (err) {
      setRowStatus(prev => ({ ...prev, [ticker]: 'failed' }))
      showPlatformToast({
        variant: 'error',
        message: err instanceof Error ? err.message : 'Watchlist add failed',
      })
    }
  }

  const syncAllToWatchlist = async () => {
    if (!selectedId) return
    setSyncingBulk(true)
    try {
      const { screener: updated, summary } = await syncScreenerWatchlist(selectedId, {
        account_env: 'demo',
      })
      setScreener(updated)
      setLastSummary(summary)
      const next: RowSyncStatus = {}
      for (const item of summary.items) {
        next[item.ticker] = item.status as RowSyncStatus[string]
      }
      setRowStatus(next)
      showPlatformToast({
        variant: 'success',
        message: `Watchlist: +${summary.added} added, ${summary.already_present} existing, ${summary.unmatched} unmatched`,
      })
    } catch (err) {
      showPlatformToast({
        variant: 'error',
        message: err instanceof Error ? err.message : 'Bulk sync failed',
      })
    } finally {
      setSyncingBulk(false)
    }
  }

  const fieldOptions = fields.length
    ? fields
    : (draftDefinition.columns || []).map(key => ({
        key,
        label: key,
        type: 'number',
        ops: [
          { id: 'greater', label: '>' },
          { id: 'less', label: '<' },
          { id: 'equal', label: '=' },
        ],
      }))

  const opsFor = (left: string) => {
    const field = fieldOptions.find(f => f.key === left)
    return field?.ops || [
      { id: 'greater', label: '>' },
      { id: 'less', label: '<' },
      { id: 'equal', label: '=' },
      { id: 'between', label: 'between' },
      { id: 'nempty', label: 'not empty' },
    ]
  }

  return (
    <div className="scr-root">
      <div className="scr-toolbar">
        <span className="scr-toolbar-title">Screener</span>
        <a
          className="scr-helpful-link"
          href="https://www.thestockcatalyst.com/NYSEPMMovers#autoreload"
          target="_blank"
          rel="noopener noreferrer"
          title="NYSE pre-market movers (Stock Catalyst)"
        >
          Helpful: NYSE PM Movers
        </a>
        <div className="scr-pills" role="tablist" aria-label="Saved screeners">
          {screeners.map(item => {
            const active = item.id === selectedId
            const editing = editingId === item.id
            return (
              <div
                key={item.id}
                className={`scr-pill-wrap${active ? ' scr-pill-wrap--active' : ''}`}
              >
                {editing ? (
                  <input
                    ref={nameInputRef}
                    className="scr-pill-edit-input"
                    value={nameDraft}
                    aria-label="Screener name"
                    onChange={e => setNameDraft(e.target.value)}
                    onBlur={() => void commitRename()}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void commitRename()
                      }
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                  />
                ) : (
                  <>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      className={`scr-pill${active ? ' scr-pill--active' : ''}`}
                      onClick={() => void selectScreener(item.id)}
                      onDoubleClick={() => startRename(item)}
                      title="Double-click to rename"
                    >
                      {item.name}
                    </button>
                    <button
                      type="button"
                      className="scr-pill-icon-btn"
                      title="Rename screener"
                      aria-label={`Rename ${item.name}`}
                      onClick={() => startRename(item)}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="scr-pill-icon-btn scr-pill-icon-btn--danger"
                      title="Delete screener"
                      aria-label={`Delete ${item.name}`}
                      onClick={() => void handleDelete(item.id)}
                    >
                      ×
                    </button>
                  </>
                )}
              </div>
            )
          })}
          <button type="button" className="scr-pill scr-pill--add" onClick={() => void handleCreate()}>
            + New
          </button>
        </div>
        <div className="scr-toolbar-spacer" />
        <button
          type="button"
          className="scr-btn"
          onClick={() => setEditorOpen(v => !v)}
          aria-pressed={editorOpen}
        >
          {editorOpen ? 'Hide editor' : 'Edit query'}
        </button>
      </div>

      <div className="scr-meta">
        <span className={`scr-status ${statusClass(selected?.refresh_status || 'idle')}`}>
          {refreshing || selected?.refresh_status === 'running' ? 'running' : selected?.refresh_status || 'idle'}
        </span>
        <span>
          Results: <strong>{selected?.results?.length ?? 0}</strong>
          {selected?.total_count ? ` / ${selected.total_count}` : ''}
        </span>
        <span>
          Last refresh: <strong>{formatTime(selected?.last_refreshed_at)}</strong>
        </span>
        {selected?.last_error ? <span className="scr-status scr-status--error">{selected.last_error}</span> : null}
        <div className="scr-toolbar-spacer" />
        <label className="scr-toggle">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={e => void persistAutoRefresh(e.target.checked, autoInterval)}
            disabled={!selected}
          />
          Auto refresh
        </label>
        <select
          className="scr-select"
          value={autoInterval}
          disabled={!selected}
          onChange={e => void persistAutoRefresh(autoRefresh, Number(e.target.value))}
          aria-label="Auto refresh interval"
        >
          <option value={30}>30s</option>
          <option value={60}>60s</option>
          <option value={120}>2m</option>
          <option value={300}>5m</option>
        </select>
        <button
          type="button"
          className="scr-btn scr-btn--primary"
          disabled={!selected || refreshing}
          onClick={() => void doRefresh()}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
        <button
          type="button"
          className="scr-btn scr-btn--success"
          disabled={!selected || !selected.results?.length || syncingBulk}
          onClick={() => void syncAllToWatchlist()}
        >
          {syncingBulk ? 'Syncing…' : 'Add all to eToro watchlist'}
        </button>
      </div>

      {lastSummary ? (
        <div className="scr-meta">
          <div className="scr-summary-toast" role="status">
            Synced to <strong>{lastSummary.watchlist_name}</strong>: +{lastSummary.added} added,{' '}
            {lastSummary.already_present} existing, {lastSummary.unmatched} unmatched
            {lastSummary.failed ? `, ${lastSummary.failed} failed` : ''}
          </div>
        </div>
      ) : null}

      <div className="scr-body">
        <div className="scr-main">
          {loading ? (
            <div className="scr-loading" aria-busy="true">Loading screeners…</div>
          ) : error && !selected?.results?.length ? (
            <div className="scr-error" role="alert">
              <p>{error}</p>
              <button type="button" className="scr-btn" onClick={() => void doRefresh()}>
                Retry
              </button>
            </div>
          ) : !selected ? (
            <div className="scr-empty">
              <p>No screeners yet.</p>
              <button type="button" className="scr-btn scr-btn--primary" onClick={() => void handleCreate()}>
                Create screener
              </button>
            </div>
          ) : !selected.results?.length ? (
            <div className="scr-empty">
              <p>{error || 'No results yet. Refresh to run this screener against TradingView.'}</p>
              <button type="button" className="scr-btn scr-btn--primary" onClick={() => void doRefresh()}>
                Run screener
              </button>
            </div>
          ) : (
            <>
              <div className="scr-table-wrap">
                <table className="scr-table">
                  <thead>
                    <tr>
                      {columns.map(col => (
                        <th
                          key={col}
                          className={[
                            col !== 'ticker' ? 'scr-th--num' : '',
                            sort?.key === col ? 'scr-th--sorted' : '',
                          ].filter(Boolean).join(' ') || undefined}
                          onClick={() => toggleSort(col)}
                        >
                          {columnLabel(col)}
                          {sort?.key === col ? (
                            <span className="scr-th-sort">{sort.dir === 'asc' ? ' ↑' : ' ↓'}</span>
                          ) : null}
                        </th>
                      ))}
                      <th>Watchlist</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedRows.map(row => {
                      const ticker = row.ticker
                      const symbol = tickerSymbol(ticker)
                      const status = rowStatus[ticker]
                      return (
                        <tr key={row.id || ticker}>
                          {columns.map(col => {
                            if (col === 'ticker') {
                              return (
                                <td key={col}>
                                  <span className="scr-symbol">
                                    <span className="scr-symbol-badge">{symbol}</span>
                                    <span className="scr-symbol-name">{row.name || row.cells?.description || ''}</span>
                                  </span>
                                </td>
                              )
                            }
                            const raw = row.cells?.[col]
                            const kind = cellKind(col)
                            const formatted = formatScreenerNumber(raw, kind)
                            if (kind === 'percent') {
                              return (
                                <td key={col} className="scr-td--num">
                                  <span className={`scr-chg ${changeClass(raw)}`}>{formatted}</span>
                                </td>
                              )
                            }
                            return (
                              <td key={col} className="scr-td--num">
                                {formatted}
                              </td>
                            )
                          })}
                          <td>
                            <div className="scr-row-actions">
                              <button
                                type="button"
                                className={`scr-row-btn${
                                  status === 'added' || status === 'already_present'
                                    ? ' scr-row-btn--ok'
                                    : status === 'unmatched' || status === 'failed'
                                      ? ' scr-row-btn--miss'
                                      : ''
                                }`}
                                disabled={status === 'adding'}
                                onClick={() => void addRowToWatchlist(ticker)}
                              >
                                {status === 'adding'
                                  ? '…'
                                  : status === 'added'
                                    ? 'Added'
                                    : status === 'already_present'
                                      ? 'In list'
                                      : status === 'unmatched'
                                        ? 'N/A'
                                        : 'Add'}
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="scr-pagination">
                <label className="scr-toggle">
                  Rows
                  <select
                    className="scr-select"
                    value={pageSize}
                    onChange={e => {
                      setPageSize(Number(e.target.value))
                      setPage(1)
                    }}
                  >
                    {PAGE_SIZES.map(n => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="scr-page-btn"
                  disabled={currentPage <= 1}
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                >
                  Prev
                </button>
                <span>
                  {currentPage}/{pageCount}
                </span>
                <button
                  type="button"
                  className="scr-page-btn"
                  disabled={currentPage >= pageCount}
                  onClick={() => setPage(p => Math.min(pageCount, p + 1))}
                >
                  Next
                </button>
              </div>
            </>
          )}
        </div>

        {editorOpen ? (
          <aside className="scr-editor" aria-label="Screener query editor">
            <div className="scr-editor-header">
              <span className="scr-editor-title">Query</span>
              <div className="scr-editor-tabs">
                <button
                  type="button"
                  className={`scr-editor-tab${editorMode === 'filters' ? ' scr-editor-tab--active' : ''}`}
                  onClick={() => setEditorMode('filters')}
                >
                  Filters
                </button>
                <button
                  type="button"
                  className={`scr-editor-tab${editorMode === 'dsl' ? ' scr-editor-tab--active' : ''}`}
                  onClick={() => {
                    setDraftDsl(definitionToDsl(draftDefinition))
                    setEditorMode('dsl')
                  }}
                >
                  Python DSL
                </button>
              </div>
            </div>
            <div className="scr-editor-body">
              {editorMode === 'filters' ? (
                <>
                  <div className="scr-field">
                    <span className="scr-label">Columns</span>
                    <div className="scr-chips">
                      {(draftDefinition.columns || []).map(col => (
                        <span key={col} className="scr-chip">
                          {col}
                          <button
                            type="button"
                            aria-label={`Remove ${col}`}
                            onClick={() => {
                              const next = {
                                ...draftDefinition,
                                columns: draftDefinition.columns.filter(c => c !== col),
                              }
                              setDraftDefinition(next)
                              setDraftDsl(definitionToDsl(next))
                            }}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                    <select
                      className="scr-select"
                      value=""
                      onChange={e => {
                        const key = e.target.value
                        if (!key || draftDefinition.columns.includes(key)) return
                        const next = {
                          ...draftDefinition,
                          columns: [...draftDefinition.columns, key],
                        }
                        setDraftDefinition(next)
                        setDraftDsl(definitionToDsl(next))
                      }}
                      aria-label="Add column"
                    >
                      <option value="">Add column…</option>
                      {fieldOptions.map(f => (
                        <option key={f.key} value={f.key}>{f.label} ({f.key})</option>
                      ))}
                    </select>
                  </div>

                  <div className="scr-field">
                    <span className="scr-label">Filters (AND)</span>
                    {(draftDefinition.filters || []).map((filt, idx) => (
                      <div key={`${filt.left}-${idx}`} className="scr-filter-row">
                        <select
                          className="scr-select"
                          value={filt.left}
                          onChange={e => {
                            const filters = [...(draftDefinition.filters || [])]
                            filters[idx] = { ...filt, left: e.target.value }
                            updateDraftFilters(filters)
                          }}
                        >
                          {fieldOptions.map(f => (
                            <option key={f.key} value={f.key}>{f.label}</option>
                          ))}
                        </select>
                        <select
                          className="scr-select"
                          value={filt.operation}
                          onChange={e => {
                            const filters = [...(draftDefinition.filters || [])]
                            filters[idx] = { ...filt, operation: e.target.value }
                            updateDraftFilters(filters)
                          }}
                        >
                          {opsFor(filt.left).map(op => (
                            <option key={op.id} value={op.id === 'between' ? 'in_range' : op.id}>
                              {op.label}
                            </option>
                          ))}
                        </select>
                        {filt.operation === 'empty' || filt.operation === 'nempty' ? (
                          <span className="scr-hint">—</span>
                        ) : filt.operation === 'in_range' || filt.operation === 'not_in_range' ? (
                          <input
                            className="scr-input"
                            value={Array.isArray(filt.right) ? filt.right.join(',') : String(filt.right ?? '')}
                            placeholder="min,max or a,b,c"
                            onChange={e => {
                              const parts = e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                              const nums = parts.map(p => (Number.isFinite(Number(p)) ? Number(p) : p))
                              const filters = [...(draftDefinition.filters || [])]
                              filters[idx] = { ...filt, right: nums }
                              updateDraftFilters(filters)
                            }}
                          />
                        ) : (
                          <input
                            className="scr-input"
                            value={String(filt.right ?? '')}
                            onChange={e => {
                              const raw = e.target.value
                              const num = Number(raw)
                              const filters = [...(draftDefinition.filters || [])]
                              filters[idx] = {
                                ...filt,
                                right: raw === '' ? '' : Number.isFinite(num) && raw.trim() !== '' ? num : raw,
                              }
                              updateDraftFilters(filters)
                            }}
                          />
                        )}
                        <button
                          type="button"
                          className="scr-btn scr-btn--ghost"
                          aria-label="Remove filter"
                          onClick={() => {
                            const filters = (draftDefinition.filters || []).filter((_, i) => i !== idx)
                            updateDraftFilters(filters)
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="scr-btn"
                      onClick={() => updateDraftFilters([...(draftDefinition.filters || []), defaultFilter()])}
                    >
                      + Filter
                    </button>
                  </div>

                  <div className="scr-filter-row" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
                    <div className="scr-field">
                      <span className="scr-label">Order by</span>
                      <select
                        className="scr-select"
                        value={draftDefinition.order_by || ''}
                        onChange={e => {
                          const next = { ...draftDefinition, order_by: e.target.value || null }
                          setDraftDefinition(next)
                          setDraftDsl(definitionToDsl(next))
                        }}
                      >
                        <option value="">None</option>
                        {fieldOptions.map(f => (
                          <option key={f.key} value={f.key}>{f.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="scr-field">
                      <span className="scr-label">Direction</span>
                      <select
                        className="scr-select"
                        value={draftDefinition.ascending ? 'asc' : 'desc'}
                        onChange={e => {
                          const next = { ...draftDefinition, ascending: e.target.value === 'asc' }
                          setDraftDefinition(next)
                          setDraftDsl(definitionToDsl(next))
                        }}
                      >
                        <option value="desc">Desc</option>
                        <option value="asc">Asc</option>
                      </select>
                    </div>
                    <div className="scr-field">
                      <span className="scr-label">Limit</span>
                      <input
                        className="scr-input"
                        type="number"
                        min={1}
                        max={500}
                        value={draftDefinition.limit ?? 50}
                        onChange={e => {
                          const next = { ...draftDefinition, limit: Number(e.target.value) || 50 }
                          setDraftDefinition(next)
                          setDraftDsl(definitionToDsl(next))
                        }}
                      />
                    </div>
                  </div>
                  <p className="scr-hint">
                    Field reference:{' '}
                    <a
                      href="https://shner-elmo.github.io/TradingView-Screener/fields/stocks.html"
                      target="_blank"
                      rel="noreferrer"
                    >
                      TradingView stock fields
                    </a>
                  </p>
                </>
              ) : (
                <>
                  <div className="scr-field">
                    <span className="scr-label">Python-style Query</span>
                    <textarea
                      className="scr-textarea"
                      value={draftDsl}
                      onChange={e => {
                        setDraftDsl(e.target.value)
                        setDslError('')
                      }}
                      spellCheck={false}
                      aria-label="Screener DSL"
                    />
                  </div>
                  {dslError ? <p className="scr-hint" style={{ color: '#b91c1c' }}>{dslError}</p> : null}
                  <p className="scr-hint">
                    Restricted DSL only: Query / Column / col / And / Or method chains. Arbitrary Python is rejected.
                  </p>
                </>
              )}
            </div>
            <div className="scr-editor-footer">
              <button
                type="button"
                className="scr-btn scr-btn--primary"
                disabled={!selected || saving}
                onClick={() => void saveDefinition()}
              >
                {saving ? 'Saving…' : 'Save & run'}
              </button>
              <button
                type="button"
                className="scr-btn"
                disabled={!selected}
                onClick={() => {
                  if (!selected) return
                  setDraftDefinition(selected.definition || emptyDefinition())
                  setDraftDsl(selected.dsl_text || definitionToDsl(selected.definition || emptyDefinition()))
                  setDslError('')
                }}
              >
                Reset
              </button>
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  )
}
