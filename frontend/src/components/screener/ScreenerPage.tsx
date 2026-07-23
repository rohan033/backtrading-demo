import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  createScreener,
  deleteScreener,
  fetchScreener,
  fetchScreenerFields,
  fetchScreenerPresets,
  fetchScreeners,
  generateScreenerFromText,
  refreshScreener,
  syncScreenerWatchlist,
  updateScreener,
  validateScreenerDsl,
  type Screener,
  type ScreenerDefinition,
  type ScreenerField,
  type ScreenerFilterCond,
  type ScreenerPreset,
  type WatchlistSyncSummary,
} from '../../lib/screenerApi'
import {
  defaultParamsForModel,
  listCursorAgentModels,
  paramValueFor,
  setParamValue,
  type AgentModelParamSelection,
  type CursorAgentModel,
} from '../../lib/cursorAgentModels'
import {
  definitionToDsl,
  emptyDefinition,
  formatScreenerNumber,
  tickerSymbol,
} from '../../lib/screenerDefinition'
import { showPlatformToast } from '../../lib/platform-toast'
import { safeSetItem } from '../../lib/safeStorage'
import './Screener.css'

type EditorMode = 'filters' | 'dsl' | 'ai'
type SortState = { key: string; dir: 'asc' | 'desc' } | null
type RowSyncStatus = Record<string, 'adding' | 'added' | 'already_present' | 'unmatched' | 'failed'>
type ResultsViewMode = 'table' | 'cards'

const EDITOR_WIDTH_KEY = 'screener-editor-width-v1'
const VIEW_MODE_KEY = 'screener-view-mode-v1'
const CARD_HERO_KEY = 'screener-card-hero-v1'
const EDITOR_MIN_WIDTH = 320
const EDITOR_MAX_WIDTH = 720
const EDITOR_DEFAULT_WIDTH = 420

function loadEditorWidth(): number {
  try {
    const value = Number(localStorage.getItem(EDITOR_WIDTH_KEY))
    if (Number.isFinite(value)) {
      return Math.min(EDITOR_MAX_WIDTH, Math.max(EDITOR_MIN_WIDTH, value))
    }
  } catch {
    // ignore
  }
  return EDITOR_DEFAULT_WIDTH
}

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
  postmarket_change: 'Post-mkt chg %',
  postmarket_volume: 'Post-mkt vol',
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

function loadViewMode(): ResultsViewMode {
  try {
    const value = localStorage.getItem(VIEW_MODE_KEY)
    if (value === 'table' || value === 'cards') return value
  } catch {
    // ignore
  }
  return 'table'
}

function loadCardHeroField(): string {
  try {
    const value = localStorage.getItem(CARD_HERO_KEY)
    if (value) return value
  } catch {
    // ignore
  }
  return 'change'
}

function watchlistButtonLabel(status: RowSyncStatus[string] | undefined): string {
  if (status === 'adding') return '…'
  if (status === 'added') return 'Added'
  if (status === 'already_present') return 'In list'
  if (status === 'unmatched') return 'N/A'
  return 'Add'
}

function defaultFilter(): ScreenerFilterCond {
  return { left: 'premarket_change', operation: 'greater', right: 5 }
}

export default function ScreenerPage() {
  const [screeners, setScreeners] = useState<Screener[]>([])
  const [presets, setPresets] = useState<ScreenerPreset[]>([])
  const [presetMenuOpen, setPresetMenuOpen] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiGenerating, setAiGenerating] = useState(false)
  const [models, setModels] = useState<CursorAgentModel[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState('')
  const [agentModelId, setAgentModelId] = useState('')
  const [agentModelParams, setAgentModelParams] = useState<AgentModelParamSelection[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [screener, setScreener] = useState<Screener | null>(null)
  const [fields, setFields] = useState<ScreenerField[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [editorOpen, setEditorOpen] = useState(true)
  const [editorWidth, setEditorWidth] = useState(loadEditorWidth)
  const editorResizeRef = useRef<{ startX: number; startWidth: number } | null>(null)
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
  const [viewMode, setViewMode] = useState<ResultsViewMode>(loadViewMode)
  const [cardHeroField, setCardHeroField] = useState<string>(loadCardHeroField)
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
      const [list, fieldList, presetList] = await Promise.all([
        fetchScreeners(false),
        fetchScreenerFields(),
        fetchScreenerPresets().catch(() => [] as ScreenerPreset[]),
      ])
      setScreeners(list)
      setFields(fieldList)
      setPresets(presetList)
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

  const builtinNames = useMemo(
    () => new Set(presets.map(p => p.name.trim().toLowerCase())),
    [presets],
  )

  const missingPresets = useMemo(() => {
    const have = new Set(screeners.map(s => s.name.trim().toLowerCase()))
    return presets.filter(p => !have.has(p.name.trim().toLowerCase()))
  }, [presets, screeners])

  useEffect(() => {
    void loadList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let cancelled = false
    setModelsLoading(true)
    setModelsError('')
    void listCursorAgentModels()
      .then(rows => {
        if (cancelled) return
        setModels(rows)
        setModelsLoading(false)
        if (!rows.length) return
        const preferred =
          rows.find(m => m.id === 'composer-2.5')
          || rows.find(m => m.variants?.some(v => v.is_default))
          || rows[0]
        setAgentModelId(prev => {
          if (prev && rows.some(m => m.id === prev)) return prev
          return preferred.id
        })
        setAgentModelParams(prev => (prev.length ? prev : defaultParamsForModel(preferred)))
      })
      .catch(err => {
        if (cancelled) return
        setModels([])
        setModelsLoading(false)
        setModelsError(err instanceof Error ? err.message : 'Failed to load models')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const selectedModel = useMemo(
    () => models.find(m => m.id === agentModelId) || null,
    [models, agentModelId],
  )

  const activeVariantName =
    selectedModel?.variants?.find(v => {
      const vp = (v.params || []).map(p => `${p.id}=${p.value}`).sort().join('|')
      const cur = [...agentModelParams].map(p => `${p.id}=${p.value}`).sort().join('|')
      return vp === cur
    })?.display_name || ''

  const handleModelChange = useCallback((modelId: string) => {
    setAgentModelId(modelId)
    const model = models.find(m => m.id === modelId) || null
    setAgentModelParams(defaultParamsForModel(model))
  }, [models])

  const handleVariantSelect = useCallback((variantDisplayName: string) => {
    if (!selectedModel) return
    const variant = selectedModel.variants?.find(v => v.display_name === variantDisplayName)
    if (!variant) return
    setAgentModelParams(
      (variant.params || [])
        .filter(p => p.id && p.value)
        .map(p => ({ id: String(p.id), value: String(p.value) })),
    )
  }, [selectedModel])

  const startEditorResize = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    editorResizeRef.current = { startX: event.clientX, startWidth: editorWidth }
    document.body.classList.add('scr-resizing')

    const onMove = (moveEvent: MouseEvent) => {
      const active = editorResizeRef.current
      if (!active) return
      // Editor is on the right — drag left to widen.
      const next = Math.min(
        EDITOR_MAX_WIDTH,
        Math.max(EDITOR_MIN_WIDTH, active.startWidth + active.startX - moveEvent.clientX),
      )
      setEditorWidth(next)
      safeSetItem(EDITOR_WIDTH_KEY, String(next))
    }

    const onUp = () => {
      editorResizeRef.current = null
      document.body.classList.remove('scr-resizing')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [editorWidth])

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

  const percentColumnOptions = useMemo(
    () => columns.filter(col => col !== 'ticker' && cellKind(col) === 'percent'),
    [columns],
  )

  const effectiveCardHeroField = useMemo(() => {
    if (percentColumnOptions.includes(cardHeroField)) return cardHeroField
    return percentColumnOptions[0] || 'change'
  }, [cardHeroField, percentColumnOptions])

  const cardFootFields = useMemo(() => {
    const preferred = ['close', 'volume', 'premarket_volume', 'postmarket_volume']
    const fromCols = preferred.filter(key => columns.includes(key))
    if (fromCols.length) return fromCols.slice(0, 3)
    const price = columns.find(col => cellKind(col) === 'price')
    const vol = columns.find(col => col.includes('volume'))
    return [price, vol].filter((col): col is string => Boolean(col))
  }, [columns])

  const cardHoverFields = useMemo(
    () => columns.filter(col => {
      if (col === 'ticker') return false
      if (col === effectiveCardHeroField) return false
      if (cardFootFields.includes(col)) return false
      return true
    }),
    [columns, effectiveCardHeroField, cardFootFields],
  )

  const handleViewModeChange = (mode: ResultsViewMode) => {
    setViewMode(mode)
    safeSetItem(VIEW_MODE_KEY, mode)
  }

  const handleCardHeroChange = (field: string) => {
    setCardHeroField(field)
    safeSetItem(CARD_HERO_KEY, field)
  }

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

  const handleCreateFromPreset = async (preset: ScreenerPreset) => {
    setPresetMenuOpen(false)
    const existing = screeners.find(
      s => s.name.trim().toLowerCase() === preset.name.trim().toLowerCase(),
    )
    if (existing) {
      await selectScreener(existing.id)
      return
    }
    try {
      const created = await createScreener({
        name: preset.name,
        definition: preset.definition,
      })
      setScreeners(prev => [...prev, created])
      await selectScreener(created.id)
      setEditorOpen(true)
      showPlatformToast({
        variant: 'success',
        message: `Added preset “${preset.name}”`,
      })
    } catch (err) {
      showPlatformToast({
        variant: 'error',
        message: err instanceof Error ? err.message : 'Failed to add preset',
      })
    }
  }

  const handleAiGenerate = async () => {
    const text = aiPrompt.trim()
    if (!text || aiGenerating) return
    setAiGenerating(true)
    setPresetMenuOpen(false)
    try {
      const result = await generateScreenerFromText(text, {
        create: true,
        modelId: agentModelId || null,
        modelParams: agentModelParams,
      })
      const created = result.screener
      if (!created?.id) {
        throw new Error('AI did not return a saved screener')
      }
      setScreeners(prev => [...prev, created])
      setAiPrompt('')
      await selectScreener(created.id)
      setEditorOpen(true)
      setEditorMode('filters')
      showPlatformToast({
        variant: 'success',
        message: result.explanation
          ? `Created “${result.name}” — ${result.explanation}`
          : `Created “${result.name}”`,
        duration: 8000,
      })
    } catch (err) {
      showPlatformToast({
        variant: 'error',
        message: err instanceof Error ? err.message : 'AI generate failed',
        duration: 10000,
      })
    } finally {
      setAiGenerating(false)
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
            const isBuiltin = builtinNames.has(item.name.trim().toLowerCase())
            return (
              <div
                key={item.id}
                className={`scr-pill-wrap${active ? ' scr-pill-wrap--active' : ''}${isBuiltin ? ' scr-pill-wrap--builtin' : ''}`}
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
                      className={`scr-pill${active ? ' scr-pill--active' : ''}${isBuiltin ? ' scr-pill--builtin' : ''}`}
                      onClick={() => void selectScreener(item.id)}
                      onDoubleClick={() => startRename(item)}
                      title={isBuiltin ? 'Built-in preset · double-click to rename' : 'Double-click to rename'}
                    >
                      {isBuiltin ? <span className="scr-pill-badge" aria-hidden>★</span> : null}
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
          {presets.length > 0 ? (
            <div className="scr-preset-menu">
              <button
                type="button"
                className="scr-pill scr-pill--preset"
                aria-expanded={presetMenuOpen}
                aria-haspopup="menu"
                onClick={() => setPresetMenuOpen(v => !v)}
              >
                Built-in presets
                {missingPresets.length ? ` (${missingPresets.length})` : ''}
              </button>
              {presetMenuOpen ? (
                <div className="scr-preset-dropdown" role="menu">
                  {presets.map(preset => {
                    const installed = !missingPresets.some(p => p.key === preset.key)
                    return (
                      <button
                        key={preset.key}
                        type="button"
                        role="menuitem"
                        className="scr-preset-item"
                        disabled={installed}
                        onClick={() => void handleCreateFromPreset(preset)}
                        title={preset.description || preset.phase}
                      >
                        <strong>{preset.name}</strong>
                        <span>{installed ? 'Already added' : preset.description || preset.phase}</span>
                      </button>
                    )
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
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
        {selected?.results?.length ? (
          <>
            <div className="scr-view-toggle" role="group" aria-label="Results view">
              <button
                type="button"
                className={`scr-view-btn${viewMode === 'table' ? ' scr-view-btn--active' : ''}`}
                aria-pressed={viewMode === 'table'}
                onClick={() => handleViewModeChange('table')}
              >
                Table
              </button>
              <button
                type="button"
                className={`scr-view-btn${viewMode === 'cards' ? ' scr-view-btn--active' : ''}`}
                aria-pressed={viewMode === 'cards'}
                onClick={() => handleViewModeChange('cards')}
              >
                Cards
              </button>
            </div>
            {viewMode === 'cards' && percentColumnOptions.length ? (
              <label className="scr-toggle">
                Hero %
                <select
                  className="scr-select"
                  value={effectiveCardHeroField}
                  onChange={e => handleCardHeroChange(e.target.value)}
                  aria-label="Card hero percent field"
                >
                  {percentColumnOptions.map(col => (
                    <option key={col} value={col}>{columnLabel(col)}</option>
                  ))}
                </select>
              </label>
            ) : null}
          </>
        ) : null}
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
              <div className="scr-empty-actions">
                <button type="button" className="scr-btn scr-btn--primary" onClick={() => void handleCreate()}>
                  Create screener
                </button>
                {presets[0] ? (
                  <button
                    type="button"
                    className="scr-btn"
                    onClick={() => void handleCreateFromPreset(presets[0])}
                  >
                    Add “{presets[0].name}”
                  </button>
                ) : null}
              </div>
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
              {viewMode === 'table' ? (
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
                                  {watchlistButtonLabel(status)}
                                </button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="scr-cards-wrap">
                  <div className="scr-cards-grid">
                    {pagedRows.map(row => {
                      const ticker = row.ticker
                      const symbol = tickerSymbol(ticker)
                      const status = rowStatus[ticker]
                      const heroRaw = row.cells?.[effectiveCardHeroField]
                      const heroFormatted = formatScreenerNumber(heroRaw, 'percent')
                      return (
                        <article key={row.id || ticker} className="scr-card">
                          <div className="scr-card__face">
                            <div className="scr-card__head">
                              <span className="scr-symbol-badge">{symbol}</span>
                              <button
                                type="button"
                                className={`scr-card__watch${
                                  status === 'added' || status === 'already_present'
                                    ? ' scr-card__watch--ok'
                                    : status === 'unmatched' || status === 'failed'
                                      ? ' scr-card__watch--miss'
                                      : ''
                                }`}
                                disabled={status === 'adding'}
                                onClick={() => void addRowToWatchlist(ticker)}
                              >
                                {watchlistButtonLabel(status)}
                              </button>
                            </div>
                            <div className={`scr-card__hero ${changeClass(heroRaw)}`}>
                              {heroFormatted}
                            </div>
                            <div className="scr-card__hero-label">{columnLabel(effectiveCardHeroField)}</div>
                            <div className="scr-card__foot">
                              {cardFootFields.map(col => {
                                const raw = row.cells?.[col]
                                const kind = cellKind(col)
                                return (
                                  <div key={col} className="scr-card__foot-item">
                                    <span className="scr-card__foot-label">{columnLabel(col)}</span>
                                    <span className="scr-card__foot-value">{formatScreenerNumber(raw, kind)}</span>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                          <div className="scr-card__hover" aria-hidden="true">
                            <div className="scr-card__hover-title">
                              {symbol}
                              {row.name || row.cells?.description ? (
                                <span>{row.name || row.cells?.description}</span>
                              ) : null}
                            </div>
                            <dl className="scr-card__hover-grid">
                              {cardHoverFields.map(col => {
                                const raw = row.cells?.[col]
                                const kind = cellKind(col)
                                return (
                                  <div key={col} className="scr-card__hover-row">
                                    <dt>{columnLabel(col)}</dt>
                                    <dd className={kind === 'percent' ? changeClass(raw) : undefined}>
                                      {formatScreenerNumber(raw, kind)}
                                    </dd>
                                  </div>
                                )
                              })}
                            </dl>
                          </div>
                        </article>
                      )
                    })}
                  </div>
                </div>
              )}
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
          <aside
            className="scr-editor"
            aria-label="Screener query editor"
            style={{ width: editorWidth, minWidth: editorWidth }}
          >
            <div
              className="scr-editor-resize"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize query editor"
              title="Drag to resize"
              onMouseDown={startEditorResize}
            />
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
                <button
                  type="button"
                  className={`scr-editor-tab${editorMode === 'ai' ? ' scr-editor-tab--active' : ''}`}
                  onClick={() => setEditorMode('ai')}
                >
                  AI
                </button>
              </div>
            </div>
            <div className="scr-editor-body">
              {editorMode === 'ai' ? (
                <section className="scr-ai-panel scr-ai-panel--tab" aria-label="AI screener generator">
                  <div className="scr-ai-panel__head">
                    <strong>AI</strong>
                    <span>Describe a screener in plain language — Cursor builds the filters for you.</span>
                  </div>
                  {modelsLoading ? (
                    <p className="scr-hint">Loading models…</p>
                  ) : modelsError ? (
                    <p className="scr-hint scr-hint--error">{modelsError}</p>
                  ) : (
                    <div className="scr-ai-panel__models">
                      <label className="scr-field scr-field--compact">
                        <span className="scr-label">Model</span>
                        <select
                          className="scr-select"
                          value={agentModelId}
                          disabled={aiGenerating || (!models.length && !agentModelId)}
                          onChange={e => handleModelChange(e.target.value)}
                        >
                          {!models.length && agentModelId ? (
                            <option value={agentModelId}>{agentModelId}</option>
                          ) : null}
                          {!models.length && !agentModelId ? (
                            <option value="">No models available</option>
                          ) : null}
                          {models.map(m => (
                            <option key={m.id} value={m.id}>
                              {m.display_name || m.id}
                            </option>
                          ))}
                        </select>
                      </label>
                      {selectedModel?.variants?.length ? (
                        <label className="scr-field scr-field--compact">
                          <span className="scr-label">Preset</span>
                          <select
                            className="scr-select"
                            value={activeVariantName}
                            disabled={aiGenerating}
                            onChange={e => handleVariantSelect(e.target.value)}
                          >
                            <option value="">Custom</option>
                            {selectedModel.variants.map(v => (
                              <option key={v.display_name} value={v.display_name}>
                                {v.display_name}{v.is_default ? ' (default)' : ''}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : null}
                      {selectedModel?.parameters?.length ? (
                        <div className="scr-ai-panel__params">
                          {selectedModel.parameters.map(param => (
                            <label key={param.id} className="scr-field scr-field--compact">
                              <span className="scr-label">{param.display_name || param.id}</span>
                              <select
                                className="scr-select"
                                value={paramValueFor(agentModelParams, param.id)}
                                disabled={aiGenerating}
                                onChange={e => {
                                  setAgentModelParams(
                                    setParamValue(agentModelParams, param.id, e.target.value),
                                  )
                                }}
                              >
                                <option value="">—</option>
                                {(param.values || []).map(v => (
                                  <option key={v.value} value={v.value}>
                                    {v.display_name || v.value}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  )}
                  {selectedModel?.description ? (
                    <p className="scr-hint">{selectedModel.description}</p>
                  ) : null}
                  <form
                    className="scr-ai-panel__prompt"
                    onSubmit={event => {
                      event.preventDefault()
                      void handleAiGenerate()
                    }}
                  >
                    <textarea
                      id="scr-ai-prompt"
                      className="scr-textarea scr-ai-panel__textarea"
                      value={aiPrompt}
                      disabled={aiGenerating}
                      rows={5}
                      placeholder={'Describe a screener… e.g. “tech names up >2% today with relative volume >2”'}
                      onChange={e => setAiPrompt(e.target.value)}
                    />
                    <button
                      type="submit"
                      className="scr-btn scr-btn--primary"
                      disabled={aiGenerating || !aiPrompt.trim()}
                    >
                      {aiGenerating ? 'Generating…' : 'Generate'}
                    </button>
                  </form>
                </section>
              ) : editorMode === 'filters' ? (
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
              {editorMode === 'ai' ? (
                <p className="scr-hint scr-editor-footer-hint">
                  Generate creates a new screener and switches to Filters so you can review it.
                </p>
              ) : (
                <>
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
                </>
              )}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  )
}
