import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { YahooExtendedQuoteHero } from '../../components/market/YahooExtendedQuoteHero'
import { WithPerCardYahoo } from '../../components/market/WithPerCardYahoo'
import { useTradeHalts } from '../../context/TradeHaltsContext'
import { useWatchlistStream } from '../../context/WatchlistStreamContext'
import HaltedSymbolDot from '../../components/tradeHalts/HaltedSymbolDot'
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
  type ScreenerResultRow,
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
  yahooFinanceUrl,
} from '../../lib/screenerDefinition'
import { getUsMarketSession } from '../../lib/marketClock'
import { YAHOO_QUOTE_STAGGER_MS } from '../../lib/yahooFinanceApi'
import { showPlatformToast } from '../../lib/platform-toast'
import { safeSetItem } from '../../lib/safeStorage'
import { formatBrokerMoney, formatBrokerSignedMoney } from '../../lib/currency'
import {
  formatWindowChangePct,
  priceAtOrBefore,
  windowChangeTone,
} from '../../lib/watchlistChangeColumns'
import { defaultAccountEnv } from '../../lib/watchlistBrokers'
import { resolveWatchlistTickKey } from '../../lib/watchlistFeedReuse'
import type { Watchlist } from '../../lib/watchlists'
import { useUrlState } from '../../layout/minimal/useUrlState'
import './Screener.css'

type EditorMode = 'filters' | 'dsl' | 'ai'
type SortState = { key: string; dir: 'asc' | 'desc' } | null
type RowSyncStatus = Record<string, 'adding' | 'added' | 'already_present' | 'unmatched' | 'failed'>
type ResultsViewMode = 'table' | 'cards'
type HeaderLayout = 'full' | 'compact'

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
const PRESET_REFRESH_SECONDS = [10, 15, 30, 60, 120, 300] as const
const MIN_REFRESH_SECONDS = 10
const MAX_REFRESH_SECONDS = 3600
const STOCK_CATALYST_SOURCES = new Set([
  'stock_catalyst_nyse_pm',
  'stock_catalyst_nyse_ah',
])

function isStockCatalystSource(sourceType?: string | null): boolean {
  return Boolean(sourceType && STOCK_CATALYST_SOURCES.has(sourceType))
}
const STOCK_CATALYST_FIELDS: ScreenerField[] = [
  { key: 'mover_direction', label: 'Mover', type: 'text', ops: [] },
  { key: 'change_pct', label: 'Change %', type: 'percent', ops: [] },
  { key: 'change_abs', label: 'Change', type: 'price', ops: [] },
  { key: 'last_price', label: 'Last', type: 'price', ops: [] },
  { key: 'volume', label: 'Volume', type: 'number', ops: [] },
  { key: 'free_float', label: 'Free float', type: 'number', ops: [] },
  { key: 'short_float', label: 'Short float', type: 'number', ops: [] },
  { key: 'recent_headlines', label: 'Recent headlines', type: 'headlines', ops: [] },
]
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
  'change_pct',
])
const PRICE_KEYS = new Set([
  'close',
  'open',
  'high',
  'low',
  'premarket_close',
  'premarket_change_abs',
  'postmarket_close',
  'change_abs',
  'SMA20',
  'SMA50',
  'SMA200',
  'EMA20',
  'EMA50',
  'EMA200',
  'VWAP',
  'last_price',
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
  postmarket_close: 'Post-mkt price',
  mover_direction: 'Mover',
  change_pct: 'Change %',
  change_abs: 'Change',
  last_price: 'Last',
  free_float: 'Free float',
  short_float: 'Short float',
  recent_headlines: 'Recent headlines',
}

const CARD_FACE_PRICE_KEYS = ['premarket_close', 'postmarket_close', 'close', 'change'] as const
const CARD_FACE_VOLUME_KEYS = ['premarket_volume', 'postmarket_volume', 'volume'] as const
const CARD_FACE_SHORT_LABELS: Record<string, string> = {
  premarket_close: 'Pre',
  postmarket_close: 'Post',
  close: 'Price',
  change: 'Chg',
  premarket_volume: 'Pre vol',
  postmarket_volume: 'Post vol',
  volume: 'Vol',
}

function cardFaceMetricKeys(
  row: ScreenerResultRow,
  keys: readonly string[],
  columns: string[],
): string[] {
  return keys.filter(key => {
    if (columns.includes(key)) return true
    const raw = row.cells?.[key]
    if (raw === null || raw === undefined || raw === '') return false
    const n = Number(raw)
    return Number.isFinite(n) ? true : String(raw).trim() !== ''
  })
}

function cellKind(key: string): 'percent' | 'price' | 'number' {
  if (PERCENT_KEYS.has(key)) return 'percent'
  if (PRICE_KEYS.has(key)) return 'price'
  return 'number'
}

type StockCatalystHeadline = { title: string; url: string }

function stockCatalystHeadlines(value: unknown): StockCatalystHeadline[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const title = String((item as { title?: unknown }).title || '').trim()
    const url = String((item as { url?: unknown }).url || '').trim()
    return title && url ? [{ title, url }] : []
  })
}

function isNumericColumn(key: string): boolean {
  return key !== 'ticker' && key !== 'mover_direction' && key !== 'recent_headlines'
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

type ScreenerWatchlistControlProps = {
  ticker: string
  status: RowSyncStatus[string] | undefined
  layout: 'row' | 'card'
  instrumentDraft: string
  onInstrumentDraftChange: (value: string) => void
  onAdd: () => void
  onFetchInstrument: () => void
}

function parsePercentValue(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  const text = String(raw ?? '').trim().replace(/%/g, '')
  if (!text) return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

type ScreenerLiveFeed = {
  ltp: number
  c5mPct: number | null
  c5mAbs: number | null
}

function formatEtoroLivePrice(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const digits = value < 1 ? 4 : value < 10 ? 3 : 2
  return formatBrokerMoney('etoro', value, digits)
}

function formatEtoroLiveAbs(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const digits = Math.abs(value) < 1 ? 4 : Math.abs(value) < 10 ? 3 : 2
  return formatBrokerSignedMoney('etoro', value, digits)
}

function resolveEtoroLiveTickKey(
  watchlists: Watchlist[],
  symbol: string,
  preferredEnv: 'live' | 'demo',
): string | null {
  const primary = resolveWatchlistTickKey(watchlists, {
    broker: 'etoro',
    account_env: preferredEnv,
    symbol,
  })
  if (primary) return primary
  const altEnv = preferredEnv === 'live' ? 'demo' : 'live'
  return resolveWatchlistTickKey(watchlists, {
    broker: 'etoro',
    account_env: altEnv,
    symbol,
  })
}

function ScreenerCardLiveInline({ feed }: { feed: ScreenerLiveFeed }) {
  const pctTone = windowChangeTone(feed.c5mPct)
  const absClass = feed.c5mAbs == null
    ? 'flat'
    : feed.c5mAbs > 0
      ? 'up'
      : feed.c5mAbs < 0
        ? 'down'
        : 'flat'

  return (
    <div className="scr-card__live-inline" title="eToro live · shared watchlist feed">
      <span className="scr-card__live-price">{formatEtoroLivePrice(feed.ltp)}</span>
      <span className="scr-card__live-changes">
        <span
          className={`scr-card__live-chip scr-chg scr-chg--${pctTone === 'none' ? 'flat' : pctTone}`}
          title="5-minute % change"
        >
          {formatWindowChangePct(feed.c5mPct)}
        </span>
        <span
          className={`scr-card__live-chip scr-chg scr-chg--${absClass}`}
          title="5-minute absolute change"
        >
          {formatEtoroLiveAbs(feed.c5mAbs)}
        </span>
      </span>
    </div>
  )
}

function ScreenerCardHero({
  raw,
  label,
  previousPct,
  liveFeed,
}: {
  raw: unknown
  label: string
  previousPct?: number | null
  liveFeed?: ScreenerLiveFeed | null
}) {
  const current = parsePercentValue(raw)
  const formatted = formatScreenerNumber(raw, 'percent')
  const prevFormatted = previousPct != null ? formatScreenerNumber(previousPct, 'percent') : null
  let arrow: 'up' | 'down' | 'flat' | null = null
  if (current != null && previousPct != null) {
    if (current > previousPct) arrow = 'up'
    else if (current < previousPct) arrow = 'down'
    else arrow = 'flat'
  }

  return (
    <div className="scr-card__hero-block">
      <div className="scr-card__hero-row">
        <div className="scr-card__hero-main">
          <div className={`scr-card__hero ${changeClass(raw)}`}>{formatted}</div>
          {arrow === 'up' ? (
            <span className="scr-pct-arrow scr-pct-arrow--up" title="Change % increased since last refresh">↑</span>
          ) : null}
          {arrow === 'down' ? (
            <span className="scr-pct-arrow scr-pct-arrow--down" title="Change % decreased since last refresh">↓</span>
          ) : null}
          {arrow === 'flat' ? (
            <span className="scr-pct-arrow scr-pct-arrow--flat" title="Change % unchanged since last refresh">→</span>
          ) : null}
        </div>
        {liveFeed ? <ScreenerCardLiveInline feed={liveFeed} /> : null}
      </div>
      {prevFormatted ? (
        <div className="scr-card__hero-prev">was {prevFormatted}</div>
      ) : null}
      <div className="scr-card__hero-label">{label}</div>
    </div>
  )
}

function ScreenerRankBadge({ row }: { row: ScreenerResultRow }) {
  const rank = row.rank ?? row.position + 1
  const jump = row.rank_jump
  const jumpDay = row.rank_jump_day
  const jumpTitle = [
    jump != null && jump !== 0
      ? `Moved ${jump > 0 ? 'up' : 'down'} ${Math.abs(jump)} since last refresh`
      : null,
    jumpDay != null && jumpDay !== 0
      ? `Moved ${jumpDay > 0 ? 'up' : 'down'} ${Math.abs(jumpDay)} over 24h`
      : null,
  ].filter(Boolean).join(' · ')

  return (
    <span
      className="scr-rank"
      title={jumpTitle || `Rank #${rank}`}
    >
      <span className="scr-rank__num">#{rank}</span>
      {jump != null && jump !== 0 ? (
        <span className={`scr-rank__jump ${jump > 0 ? 'scr-rank__jump--up' : 'scr-rank__jump--down'}`}>
          {jump > 0 ? `↑${jump}` : `↓${Math.abs(jump)}`}
        </span>
      ) : null}
    </span>
  )
}

function ScreenerWatchlistControl({
  ticker,
  status,
  layout,
  instrumentDraft,
  onInstrumentDraftChange,
  onAdd,
  onFetchInstrument,
}: ScreenerWatchlistControlProps) {
  const btnClass = layout === 'card' ? 'scr-card__watch' : 'scr-row-btn'
  const busy = status === 'adding'

  if (status === 'unmatched') {
    return (
      <div className={`scr-watch-manual scr-watch-manual--${layout}`}>
        <span className="scr-watch-manual__label">N/A on eToro</span>
        <div className="scr-watch-manual__row">
          <input
            className="scr-watch-manual__input"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="Instrument ID"
            value={instrumentDraft}
            disabled={busy}
            aria-label={`eToro instrument ID for ${ticker}`}
            onChange={e => onInstrumentDraftChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onFetchInstrument()
              }
            }}
          />
          <button
            type="button"
            className="scr-watch-manual__fetch"
            disabled={busy || !instrumentDraft.trim()}
            onClick={() => onFetchInstrument()}
          >
            {busy ? '…' : 'Fetch'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <button
      type="button"
      className={`${btnClass}${
        status === 'added' || status === 'already_present'
          ? layout === 'card' ? ' scr-card__watch--ok' : ' scr-row-btn--ok'
          : status === 'failed'
            ? layout === 'card' ? ' scr-card__watch--miss' : ' scr-row-btn--miss'
            : ''
      }`}
      disabled={busy}
      onClick={() => onAdd()}
    >
      {watchlistButtonLabel(status)}
    </button>
  )
}

function watchlistSummaryMessage(summary: WatchlistSyncSummary): string {
  return `Synced to ${summary.watchlist_name}: +${summary.added} added, `
    + `${summary.already_present} existing, ${summary.unmatched} unmatched`
    + (summary.failed ? `, ${summary.failed} failed` : '')
}

function clampRefreshSeconds(seconds: number): number {
  return Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, Math.round(seconds)))
}

function isPresetRefreshSeconds(seconds: number): boolean {
  return (PRESET_REFRESH_SECONDS as readonly number[]).includes(seconds)
}

function findScreenerByName(list: Screener[], name: string): Screener | undefined {
  const needle = name.trim().toLowerCase()
  if (!needle) return undefined
  return list.find(item => item.name.trim().toLowerCase() === needle)
}

function coalesceDefinition(defn: ScreenerDefinition | null | undefined): ScreenerDefinition {
  if (defn && Array.isArray(defn.columns)) {
    return defn
  }
  return emptyDefinition()
}

function definitionsEqual(a: ScreenerDefinition, b: ScreenerDefinition): boolean {
  const colsA = [...(a.columns || [])].sort().join('|')
  const colsB = [...(b.columns || [])].sort().join('|')
  if (colsA !== colsB) return false
  return JSON.stringify({ ...a, columns: undefined }) === JSON.stringify({ ...b, columns: undefined })
}

function defaultFilter(): ScreenerFilterCond {
  return { left: 'premarket_change', operation: 'greater', right: 5 }
}

export default function ScreenerPage() {
  const { state, navigate } = useUrlState()
  const { watchlists, ticks, windowChanges, historyRef } = useWatchlistStream()
  const { haltFor } = useTradeHalts()
  const etoroAccountEnv = useMemo((): 'live' | 'demo' => {
    const env = (state.home_env || '').trim().toLowerCase()
    return env === 'live' || env === 'demo' ? env : defaultAccountEnv('etoro')
  }, [state.home_env])
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
  const [editorWidth, setEditorWidth] = useState(loadEditorWidth)
  const editorResizeRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const [editorMode, setEditorMode] = useState<EditorMode>('filters')
  const [draftDefinition, setDraftDefinition] = useState<ScreenerDefinition>(emptyDefinition())
  const [draftDsl, setDraftDsl] = useState('')
  const [dslError, setDslError] = useState('')
  const [saving, setSaving] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [autoInterval, setAutoInterval] = useState(60)
  const [autoIntervalCustom, setAutoIntervalCustom] = useState(false)
  const [customIntervalDraft, setCustomIntervalDraft] = useState('60')
  const [refreshRemainingPct, setRefreshRemainingPct] = useState(100)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(20)
  const [sort, setSort] = useState<SortState>(null)
  const [viewMode, setViewMode] = useState<ResultsViewMode>(loadViewMode)
  const [headerLayout, setHeaderLayout] = useState<HeaderLayout>('full')
  const [cardHeroField, setCardHeroField] = useState<string>(loadCardHeroField)
  const [rowStatus, setRowStatus] = useState<RowSyncStatus>({})
  const [instrumentDrafts, setInstrumentDrafts] = useState<Record<string, string>>({})
  const [syncingBulk, setSyncingBulk] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)
  const refreshInFlight = useRef(false)
  const refreshCycleStartRef = useRef(Date.now())
  const autoRefreshRef = useRef(false)
  const visibleRef = useRef(typeof document !== 'undefined' ? document.visibilityState === 'visible' : true)
  const draftDefinitionRef = useRef(draftDefinition)
  const draftDslRef = useRef(draftDsl)
  const selectedRef = useRef<Screener | null>(null)
  const editorModeRef = useRef(editorMode)
  const persistQueueRef = useRef(Promise.resolve<Screener | null>(null))
  const prevCardPctRef = useRef<Record<string, Record<string, number>>>({})
  const lastCardPctRefreshRef = useRef<Record<string, string>>({})
  const [cardPctPrevByTicker, setCardPctPrevByTicker] = useState<Record<string, number>>({})
  const [marketSession, setMarketSession] = useState(() => getUsMarketSession())
  const [yahooGeneration, setYahooGeneration] = useState(0)

  draftDefinitionRef.current = draftDefinition
  draftDslRef.current = draftDsl
  selectedRef.current = screener
  editorModeRef.current = editorMode
  autoRefreshRef.current = autoRefresh

  const applyDraftLocally = useCallback((next: ScreenerDefinition) => {
    draftDefinitionRef.current = next
    setDraftDefinition(next)
    setDraftDsl(definitionToDsl(next))
  }, [])

  const syncRefreshIntervalState = useCallback((seconds: number) => {
    const interval = clampRefreshSeconds(seconds)
    setAutoInterval(interval)
    setCustomIntervalDraft(String(interval))
  }, [])

  const selected = screener
  const isStockCatalyst = isStockCatalystSource(selected?.source_type)
  const urlScreenerName = state.screener?.trim() || ''
  const editorOpen = state.screener_columns !== 'hidden'

  const setEditorOpen = useCallback((open: boolean) => {
    navigate(
      { screener_columns: open ? '' : 'hidden' },
      { replace: true },
    )
  }, [navigate])

  const syncScreenerQuery = useCallback((name: string | null | undefined, replace = true) => {
    navigate({ screener: name?.trim() || '' }, { replace })
  }, [navigate])

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
      if (selectedId === id) syncScreenerQuery(updated.name)
    } catch (err) {
      showPlatformToast({
        variant: 'error',
        message: err instanceof Error ? err.message : 'Rename failed',
      })
    }
  }

  const loadList = useCallback(async (preferId?: string | null, preferName?: string | null) => {
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
      let nextId: string | null = null
      if (preferId && list.some(item => item.id === preferId)) {
        nextId = preferId
      } else if (preferName) {
        nextId = findScreenerByName(list, preferName)?.id ?? null
      }
      if (!nextId && selectedId && list.some(item => item.id === selectedId)) {
        nextId = selectedId
      }
      if (!nextId) {
        nextId = list[0]?.id ?? null
      }
      setSelectedId(nextId)
      if (nextId) {
        const full = await fetchScreener(nextId)
        const defn = coalesceDefinition(full.definition)
        setScreener(full)
        setDraftDefinition(defn)
        setDraftDsl(isStockCatalystSource(full.source_type) ? '' : full.dsl_text || definitionToDsl(defn))
        if (isStockCatalystSource(full.source_type)) setEditorMode('filters')
        setAutoRefresh(Boolean(full.auto_refresh_seconds && full.auto_refresh_seconds > 0))
        const refreshSeconds = full.auto_refresh_seconds > 0 ? full.auto_refresh_seconds : 60
        syncRefreshIntervalState(refreshSeconds)
        setAutoIntervalCustom(
          full.auto_refresh_seconds > 0 && !isPresetRefreshSeconds(refreshSeconds),
        )
        syncScreenerQuery(full.name)
      } else {
        setScreener(null)
        syncScreenerQuery(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load screeners')
    } finally {
      setLoading(false)
    }
  }, [selectedId, syncRefreshIntervalState, syncScreenerQuery])

  const builtinNames = useMemo(
    () => new Set(presets.map(p => p.name.trim().toLowerCase())),
    [presets],
  )

  const missingPresets = useMemo(() => {
    const have = new Set(screeners.map(s => s.name.trim().toLowerCase()))
    return presets.filter(p => !have.has(p.name.trim().toLowerCase()))
  }, [presets, screeners])

  useEffect(() => {
    void loadList(null, urlScreenerName || null)
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

  const selectScreener = async (id: string, opts?: { syncUrl?: boolean }) => {
    setSelectedId(id)
    setPage(1)
    setSort(null)
    setRowStatus({})
    setError('')
    try {
      const full = await fetchScreener(id)
      const defn = coalesceDefinition(full.definition)
      setScreener(full)
      setDraftDefinition(defn)
      setDraftDsl(isStockCatalystSource(full.source_type) ? '' : full.dsl_text || definitionToDsl(defn))
      if (isStockCatalystSource(full.source_type)) setEditorMode('filters')
      setAutoRefresh(Boolean(full.auto_refresh_seconds && full.auto_refresh_seconds > 0))
      const refreshSeconds = full.auto_refresh_seconds > 0 ? full.auto_refresh_seconds : 60
      syncRefreshIntervalState(refreshSeconds)
      setAutoIntervalCustom(
        full.auto_refresh_seconds > 0 && !isPresetRefreshSeconds(refreshSeconds),
      )
      setDslError('')
      if (opts?.syncUrl !== false) {
        syncScreenerQuery(full.name, false)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load screener')
    }
  }

  useEffect(() => {
    if (loading || !screeners.length || !urlScreenerName) return
    const match = findScreenerByName(screeners, urlScreenerName)
    if (!match || match.id === selectedId) return
    void selectScreener(match.id, { syncUrl: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlScreenerName, screeners, loading, selectedId])

  const isDraftDirty = useMemo(() => {
    if (!selected) return false
    if (editorMode === 'dsl') {
      return draftDsl.trim() !== (selected.dsl_text || '').trim()
    }
    return !definitionsEqual(draftDefinition, coalesceDefinition(selected.definition))
  }, [selected, draftDefinition, draftDsl, editorMode])

  const isDraftDirtyNow = useCallback(() => {
    const currentSelected = selectedRef.current
    if (!currentSelected) return false
    if (editorModeRef.current === 'dsl') {
      return draftDslRef.current.trim() !== (currentSelected.dsl_text || '').trim()
    }
    return !definitionsEqual(
      draftDefinitionRef.current,
      coalesceDefinition(currentSelected.definition),
    )
  }, [])

  const syncSavedDefinition = useCallback((updated: Screener) => {
    const defn = coalesceDefinition(updated.definition)
    setScreener(updated)
    setDraftDefinition(defn)
    setDraftDsl(
      isStockCatalystSource(updated.source_type)
        ? ''
        : updated.dsl_text || definitionToDsl(defn),
    )
    setScreeners(prev => prev.map(s => (
      s.id === updated.id ? { ...s, name: updated.name, definition: updated.definition, dsl_text: updated.dsl_text } : s
    )))
  }, [])

  const persistDraftDefinition = useCallback(async (opts?: {
    silent?: boolean
    definition?: ScreenerDefinition
  }) => {
    const run = async (): Promise<Screener | null> => {
      if (!selectedId) return null
      const definition = opts?.definition ?? draftDefinitionRef.current
      if (!definition.columns?.length) {
        showPlatformToast({ variant: 'error', message: 'Keep at least one column in the query' })
        return null
      }
      setDslError('')
      try {
        let payload: { definition?: ScreenerDefinition; dsl_text?: string }
        if (editorModeRef.current === 'dsl' && !opts?.definition) {
          const validated = await validateScreenerDsl(draftDslRef.current)
          applyDraftLocally(validated.definition)
          setDraftDsl(validated.dsl_text)
          payload = { dsl_text: validated.dsl_text }
        } else {
          payload = { definition }
          setDraftDsl(definitionToDsl(definition))
        }
        const updated = await updateScreener(selectedId, payload)
        syncSavedDefinition(updated)
        if (!opts?.silent) {
          showPlatformToast({ variant: 'success', message: 'Screener saved' })
        }
        return updated
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Save failed'
        setDslError(message)
        if (!opts?.silent) {
          showPlatformToast({ variant: 'error', message })
        }
        throw err
      }
    }
    const queued = persistQueueRef.current.then(() => run(), () => run())
    persistQueueRef.current = queued.then(() => null, () => null)
    return queued
  }, [selectedId, syncSavedDefinition, applyDraftLocally])

  const commitDefinitionChange = useCallback((next: ScreenerDefinition) => {
    if (!next.columns?.length) {
      showPlatformToast({ variant: 'error', message: 'Keep at least one column in the query' })
      return
    }
    applyDraftLocally(next)
    setDslError('')
    void persistDraftDefinition({ silent: true, definition: next }).catch(err => {
      showPlatformToast({
        variant: 'error',
        message: err instanceof Error ? err.message : 'Failed to save query change',
      })
    })
  }, [applyDraftLocally, persistDraftDefinition])

  const doRefresh = useCallback(async (opts?: { skipPersist?: boolean }) => {
    if (!selectedId || refreshInFlight.current) return
    refreshInFlight.current = true
    setRefreshing(true)
    setError('')
    try {
      if (isDraftDirtyNow() && !opts?.skipPersist) {
        await persistDraftDefinition({ silent: true })
      }
      const updated = await refreshScreener(selectedId)
      syncSavedDefinition(updated)
      setScreeners(prev => prev.map(s => (s.id === updated.id ? { ...s, ...updated, results: [] } : s)))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Refresh failed'
      setError(message)
      // Keep previous results; re-fetch to pick up error status
      try {
        const latest = await fetchScreener(selectedId)
        syncSavedDefinition(latest)
      } catch {
        /* ignore */
      }
    } finally {
      refreshInFlight.current = false
      setRefreshing(false)
      setYahooGeneration(prev => prev + 1)
      if (autoRefreshRef.current) {
        refreshCycleStartRef.current = Date.now()
        setRefreshRemainingPct(100)
      }
    }
  }, [selectedId, isDraftDirtyNow, persistDraftDefinition, syncSavedDefinition])

  useEffect(() => {
    const onVis = () => {
      visibleRef.current = document.visibilityState === 'visible'
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  useEffect(() => {
    const tick = () => setMarketSession(getUsMarketSession())
    tick()
    const id = window.setInterval(tick, 60_000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    if (!autoRefresh || !selectedId) {
      setRefreshRemainingPct(100)
      return undefined
    }

    const totalMs = clampRefreshSeconds(autoInterval) * 1000
    refreshCycleStartRef.current = Date.now()
    setRefreshRemainingPct(100)

    const tick = window.setInterval(() => {
      if (!visibleRef.current) {
        refreshCycleStartRef.current = Date.now()
        setRefreshRemainingPct(100)
        return
      }
      const elapsed = Date.now() - refreshCycleStartRef.current
      if (elapsed >= totalMs) {
        refreshCycleStartRef.current = Date.now()
        setRefreshRemainingPct(100)
        void doRefresh()
        return
      }
      setRefreshRemainingPct(Math.max(0, 100 * (1 - elapsed / totalMs)))
    }, 200)

    return () => window.clearInterval(tick)
  }, [autoRefresh, autoInterval, selectedId, doRefresh])

  const persistAutoRefresh = async (enabled: boolean, seconds: number) => {
    if (!selectedId) return
    const interval = clampRefreshSeconds(seconds)
    setAutoRefresh(enabled)
    syncRefreshIntervalState(interval)
    try {
      const updated = await updateScreener(selectedId, {
        auto_refresh_seconds: enabled ? interval : 0,
      })
      setScreener(prev => (prev ? { ...prev, auto_refresh_seconds: updated.auto_refresh_seconds } : prev))
    } catch (err) {
      showPlatformToast({
        variant: 'error',
        message: err instanceof Error ? err.message : 'Failed to save auto-refresh',
      })
    }
  }

  const commitCustomInterval = useCallback(() => {
    const parsed = Number(customIntervalDraft)
    if (!Number.isFinite(parsed)) {
      setCustomIntervalDraft(String(autoInterval))
      return
    }
    void persistAutoRefresh(autoRefresh, parsed)
  }, [autoRefresh, autoInterval, customIntervalDraft, selectedId])

  const customIntervalRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (autoIntervalCustom) {
      customIntervalRef.current?.focus()
      customIntervalRef.current?.select()
    }
  }, [autoIntervalCustom])

  const columnLabel = (key: string) => {
    const fromStockCatalyst = STOCK_CATALYST_FIELDS.find(f => f.key === key)?.label
    const fromFields = fields.find(f => f.key === key)?.label
    return (isStockCatalyst ? fromStockCatalyst : null) || fromFields || COLUMN_LABELS[key] || key
  }

  const cardMetricLabel = (key: string) => CARD_FACE_SHORT_LABELS[key] || columnLabel(key)

  const columns = useMemo(() => {
    const defCols = draftDefinition.columns || []
    const ordered: string[] = ['ticker']
    for (const col of defCols) {
      if (col === 'ticker' || col === 'name') continue
      if (!ordered.includes(col)) ordered.push(col)
    }
    return ordered.length > 0 ? ordered : ['ticker']
  }, [draftDefinition.columns])

  const percentColumnOptions = useMemo(
    () => columns.filter(col => col !== 'ticker' && cellKind(col) === 'percent'),
    [columns],
  )

  const effectiveCardHeroField = useMemo(() => {
    if (percentColumnOptions.includes(cardHeroField)) return cardHeroField
    return percentColumnOptions[0] || 'change'
  }, [cardHeroField, percentColumnOptions])

  const cardPctField = isStockCatalyst ? 'change_pct' : effectiveCardHeroField

  useEffect(() => {
    if (!selectedId || !selected?.results?.length || cellKind(cardPctField) !== 'percent') {
      setCardPctPrevByTicker({})
      return
    }
    const refreshKey = selected.last_refreshed_at || selected.updated_at || ''
    if (!refreshKey) return

    const lastKey = lastCardPctRefreshRef.current[selectedId]
    if (refreshKey !== lastKey) {
      setCardPctPrevByTicker({ ...(prevCardPctRef.current[selectedId] || {}) })
      const next: Record<string, number> = {}
      for (const row of selected.results) {
        const pct = parsePercentValue(row.cells?.[cardPctField])
        if (pct != null) next[row.ticker.toUpperCase()] = pct
      }
      prevCardPctRef.current[selectedId] = next
      lastCardPctRefreshRef.current[selectedId] = refreshKey
    } else if (!lastKey) {
      const next: Record<string, number> = {}
      for (const row of selected.results) {
        const pct = parsePercentValue(row.cells?.[cardPctField])
        if (pct != null) next[row.ticker.toUpperCase()] = pct
      }
      prevCardPctRef.current[selectedId] = next
      lastCardPctRefreshRef.current[selectedId] = refreshKey
      setCardPctPrevByTicker({})
    }
  }, [
    selectedId,
    selected?.results,
    selected?.last_refreshed_at,
    selected?.updated_at,
    cardPctField,
  ])

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

  const liveFeedByTicker = useMemo(() => {
    const map: Record<string, ScreenerLiveFeed> = {}
    const now = Date.now()
    for (const row of pagedRows) {
      const symbol = tickerSymbol(row.ticker).toUpperCase()
      if (!symbol || map[symbol]) continue
      const tickKey = resolveEtoroLiveTickKey(watchlists, symbol, etoroAccountEnv)
      if (!tickKey) continue
      const tick = ticks[tickKey]
      if (!tick?.ltp || !Number.isFinite(tick.ltp) || tick.ltp <= 0) continue
      const c5mPct = windowChanges[tickKey]?.['5m'] ?? null
      const samples = historyRef.current[tickKey] ?? []
      const past5m = priceAtOrBefore(samples, now - 5 * 60_000)
      const c5mAbs = past5m != null && past5m > 0
        ? Math.round((tick.ltp - past5m) * 10000) / 10000
        : null
      map[symbol] = { ltp: tick.ltp, c5mPct, c5mAbs }
    }
    return map
  }, [pagedRows, watchlists, ticks, windowChanges, historyRef, etoroAccountEnv])

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
    applyDraftLocally({ ...draftDefinitionRef.current, filters })
    setDslError('')
  }

  const saveDefinition = async () => {
    if (!selectedId) return
    setSaving(true)
    try {
      // Always persist the latest in-memory draft; queue ensures we don't race an in-flight auto-save.
      const saved = await persistDraftDefinition({ definition: draftDefinitionRef.current })
      if (!saved) return
      await doRefresh({ skipPersist: true })
    } catch {
      // persistDraftDefinition surfaces errors
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
          syncScreenerQuery(null)
        }
      }
    } catch (err) {
      showPlatformToast({
        variant: 'error',
        message: err instanceof Error ? err.message : 'Delete failed',
      })
    }
  }

  const addRowToWatchlist = async (ticker: string, instrumentId?: number) => {
    if (!selectedId) return
    setRowStatus(prev => ({ ...prev, [ticker]: 'adding' }))
    try {
      const { screener: updated, summary } = await syncScreenerWatchlist(selectedId, {
        tickers: [ticker],
        account_env: etoroAccountEnv,
        instrument_overrides: instrumentId != null ? { [ticker]: instrumentId } : undefined,
      })
      setScreener(updated)
      const item = summary.items[0]
      setRowStatus(prev => ({
        ...prev,
        [ticker]: (item?.status as RowSyncStatus[string]) || 'unmatched',
      }))
      if (item?.status === 'added' || item?.status === 'already_present') {
        setInstrumentDrafts(prev => {
          const next = { ...prev }
          delete next[ticker]
          return next
        })
        showPlatformToast({
          variant: 'success',
          message: watchlistSummaryMessage(summary),
        })
      } else if (instrumentId != null) {
        showPlatformToast({
          variant: 'error',
          message: item?.error || `Could not fetch instrument ${instrumentId} on eToro`,
        })
      } else {
        showPlatformToast({
          variant: 'error',
          message: watchlistSummaryMessage(summary),
        })
      }
    } catch (err) {
      setRowStatus(prev => ({ ...prev, [ticker]: instrumentId != null ? 'unmatched' : 'failed' }))
      showPlatformToast({
        variant: 'error',
        message: err instanceof Error ? err.message : 'Watchlist add failed',
      })
    }
  }

  const fetchRowInstrument = (ticker: string) => {
    const raw = (instrumentDrafts[ticker] || '').trim()
    const instrumentId = Number(raw)
    if (!raw || !Number.isInteger(instrumentId) || instrumentId <= 0) {
      showPlatformToast({
        variant: 'error',
        message: 'Enter a valid eToro instrument ID (positive integer)',
      })
      return
    }
    void addRowToWatchlist(ticker, instrumentId)
  }

  const watchlistControlProps = (ticker: string, status: RowSyncStatus[string] | undefined, layout: 'row' | 'card') => ({
    ticker,
    status,
    layout,
    instrumentDraft: instrumentDrafts[ticker] || '',
    onInstrumentDraftChange: (value: string) => {
      setInstrumentDrafts(prev => ({ ...prev, [ticker]: value }))
    },
    onAdd: () => { void addRowToWatchlist(ticker) },
    onFetchInstrument: () => fetchRowInstrument(ticker),
  })

  const syncAllToWatchlist = async () => {
    if (!selectedId) return
    setSyncingBulk(true)
    try {
      const { screener: updated, summary } = await syncScreenerWatchlist(selectedId, {
        account_env: etoroAccountEnv,
      })
      setScreener(updated)
      const next: RowSyncStatus = {}
      for (const item of summary.items) {
        next[item.ticker] = item.status as RowSyncStatus[string]
      }
      setRowStatus(next)
      showPlatformToast({
        variant: 'success',
        message: watchlistSummaryMessage(summary),
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

  const fieldOptions = isStockCatalyst
    ? STOCK_CATALYST_FIELDS
    : fields.length
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
      <div className={`scr-toolbar${headerLayout === 'compact' ? ' scr-toolbar--compact' : ''}`}>
        <div className="scr-toolbar-layout">
          <span className="scr-toolbar-layout__label">Layout</span>
          <div className="scr-view-toggle" role="group" aria-label="Screener layout">
            <button
              type="button"
              className={`scr-view-btn${headerLayout === 'full' ? ' scr-view-btn--active' : ''}`}
              aria-pressed={headerLayout === 'full'}
              onClick={() => setHeaderLayout('full')}
            >
              Tabs
            </button>
            <button
              type="button"
              className={`scr-view-btn${headerLayout === 'compact' ? ' scr-view-btn--active' : ''}`}
              aria-pressed={headerLayout === 'compact'}
              onClick={() => setHeaderLayout('compact')}
            >
              Cards only
            </button>
          </div>
        </div>
        {headerLayout === 'compact' ? (
          <label className="scr-toolbar-active-select">
            <span className="scr-toolbar-layout__label">Screener</span>
            <select
              className="scr-select scr-toolbar-active-select__input"
              value={selectedId || ''}
              onChange={e => { void selectScreener(e.target.value) }}
              aria-label="Active screener"
            >
              {screeners.map(item => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
        ) : (
          <>
        <span className="scr-toolbar-title">Screener</span>
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
          </>
        )}
        <div className="scr-toolbar-spacer" />
        {headerLayout === 'full' ? (
        <button
          type="button"
          className="scr-btn"
          onClick={() => setEditorOpen(!editorOpen)}
          aria-pressed={editorOpen}
        >
          {isStockCatalyst
            ? (editorOpen ? 'Hide columns' : 'Choose columns')
            : (editorOpen ? 'Hide editor' : 'Edit query')}
        </button>
        ) : null}
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
            {viewMode === 'cards' && percentColumnOptions.length && !isStockCatalyst ? (
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
        <div className="scr-refresh-cluster">
          <div className="scr-refresh-cluster__controls">
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
              value={autoIntervalCustom ? 'custom' : String(autoInterval)}
              disabled={!selected}
              onChange={e => {
                const value = e.target.value
                if (value === 'custom') {
                  setAutoIntervalCustom(true)
                  return
                }
                setAutoIntervalCustom(false)
                void persistAutoRefresh(autoRefresh, Number(value))
              }}
              aria-label="Auto refresh interval"
            >
              {PRESET_REFRESH_SECONDS.map(seconds => (
                <option key={seconds} value={seconds}>
                  {seconds < 60 ? `${seconds}s` : `${seconds / 60}m`}
                </option>
              ))}
              <option value="custom">Custom</option>
            </select>
            {autoIntervalCustom ? (
              <label className="scr-toggle scr-toggle--interval">
                <input
                  ref={customIntervalRef}
                  className="scr-input scr-input--interval"
                  type="number"
                  min={MIN_REFRESH_SECONDS}
                  max={MAX_REFRESH_SECONDS}
                  step={1}
                  value={customIntervalDraft}
                  disabled={!selected}
                  aria-label="Custom auto refresh seconds"
                  title={`${MIN_REFRESH_SECONDS}–${MAX_REFRESH_SECONDS} seconds`}
                  onChange={e => setCustomIntervalDraft(e.target.value)}
                  onBlur={() => commitCustomInterval()}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitCustomInterval()
                    }
                  }}
                />
                <span>s</span>
              </label>
            ) : null}
            <button
              type="button"
              className="scr-btn scr-btn--primary"
              disabled={!selected || refreshing}
              onClick={() => void doRefresh()}
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          {autoRefresh && selected ? (
            <div
              className="scr-refresh-cluster__bar"
              role="progressbar"
              aria-label="Time until next auto refresh"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(refreshRemainingPct)}
            >
              <div
                className="scr-refresh-cluster__bar-fill"
                style={{ width: `${refreshRemainingPct}%` }}
              />
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className="scr-btn scr-btn--success"
          disabled={!selected || !selected.results?.length || syncingBulk}
          onClick={() => void syncAllToWatchlist()}
        >
          {syncingBulk ? 'Syncing…' : 'Add all to eToro watchlist'}
        </button>
      </div>

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
              <p>
                {error || (isStockCatalyst
                  ? 'No results yet. Refresh to load the Stock Catalyst movers tables.'
                  : 'No results yet. Refresh to run this screener against TradingView.')}
              </p>
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
                        <th className="scr-th--rank">Rank</th>
                        {columns.map(col => (
                          <th
                            key={col}
                            className={[
                              isNumericColumn(col) ? 'scr-th--num' : '',
                              col === 'recent_headlines' ? 'scr-th--headlines' : '',
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
                            <td className="scr-td--rank">
                              <ScreenerRankBadge row={row} />
                            </td>
                            {columns.map(col => {
                              if (col === 'ticker') {
                                return (
                                  <td key={col}>
                                    <span className="scr-symbol">
                                      <a
                                        className="scr-symbol-badge scr-symbol-badge--link"
                                        href={yahooFinanceUrl(ticker)}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        title={`Open ${symbol} on Yahoo Finance`}
                                      >
                                        {symbol}
                                      </a>
                                      <HaltedSymbolDot halt={haltFor(symbol)} className="halt-dot--inline" />
                                      <span className="scr-symbol-name">{row.name || row.cells?.description || ''}</span>
                                    </span>
                                  </td>
                                )
                              }
                              const raw = row.cells?.[col]
                              if (isStockCatalyst && col === 'mover_direction') {
                                const direction = String(raw || '')
                                return (
                                  <td key={col}>
                                    <span className={`scr-mover scr-mover--${direction.toLowerCase()}`}>
                                      {direction || '—'}
                                    </span>
                                  </td>
                                )
                              }
                              if (isStockCatalyst && col === 'recent_headlines') {
                                const headlines = stockCatalystHeadlines(raw)
                                return (
                                  <td key={col} className="scr-headlines-cell">
                                    {headlines.length ? (
                                      <div className="scr-headlines">
                                        {headlines.map((headline, index) => (
                                          <a
                                            key={`${headline.url}-${index}`}
                                            href={headline.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            title={headline.title}
                                          >
                                            {headline.title}
                                          </a>
                                        ))}
                                      </div>
                                    ) : <span className="scr-muted">—</span>}
                                  </td>
                                )
                              }
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
                                <ScreenerWatchlistControl {...watchlistControlProps(ticker, status, 'row')} />
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
                    {pagedRows.map((row, cardIndex) => {
                      const ticker = row.ticker
                      const symbol = tickerSymbol(ticker)
                      const status = rowStatus[ticker]
                      const heroRaw = row.cells?.[effectiveCardHeroField]
                      const liveFeed = liveFeedByTicker[symbol.toUpperCase()]
                      if (isStockCatalyst) {
                        const direction = String(row.cells?.mover_direction || '')
                        const metricColumns = columns.filter(
                          col => col !== 'ticker'
                            && col !== 'mover_direction'
                            && col !== 'change_pct'
                            && col !== 'recent_headlines',
                        )
                        const showChangePercent = columns.includes('change_pct')
                        const headlines = columns.includes('recent_headlines')
                          ? stockCatalystHeadlines(row.cells?.recent_headlines)
                          : []
                        return (
                          <WithPerCardYahoo key={row.id || ticker}>
                            {({ yahooPriceEnabled, yahooToggle }) => (
                          <article className="scr-card scr-source-card">
                            <header className="scr-card__header">
                              <div className="scr-source-card__identity">
                                <ScreenerRankBadge row={row} />
                                <a
                                  className="scr-card__ticker-link"
                                  href={yahooFinanceUrl(ticker)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title={`Open ${symbol} on Yahoo Finance`}
                                >
                                  {symbol}
                                </a>
                                <HaltedSymbolDot halt={haltFor(symbol)} className="halt-dot--inline" />
                                {columns.includes('mover_direction') ? (
                                  <span className={`scr-mover scr-mover--${direction.toLowerCase()}`}>
                                    {direction || '—'}
                                  </span>
                                ) : null}
                              </div>
                              <div className="scr-card__header-actions">
                                {yahooToggle}
                                <ScreenerWatchlistControl {...watchlistControlProps(ticker, status, 'card')} />
                              </div>
                            </header>
                            <div className="scr-card__face scr-source-card__face">
                              <YahooExtendedQuoteHero
                                ticker={ticker}
                                enabled={yahooPriceEnabled}
                                generation={yahooGeneration}
                                active={viewMode === 'cards'}
                                staggerMs={cardIndex * YAHOO_QUOTE_STAGGER_MS}
                                className="scr-card__hero-block scr-card__hero-block--yahoo"
                              >
                                {showChangePercent ? (
                                  <ScreenerCardHero
                                    raw={row.cells?.change_pct}
                                    label="Change %"
                                    previousPct={cardPctPrevByTicker[ticker.toUpperCase()]}
                                    liveFeed={liveFeed}
                                  />
                                ) : liveFeed ? (
                                  <div className="scr-card__hero-block">
                                    <ScreenerCardLiveInline feed={liveFeed} />
                                  </div>
                                ) : null}
                              </YahooExtendedQuoteHero>
                              {metricColumns.length || columns.includes('recent_headlines') ? (
                                <div className="scr-card__foot">
                                  {metricColumns.length ? (
                                    <div className="scr-card__foot-row">
                                  {metricColumns.map(col => {
                                    const raw = row.cells?.[col]
                                    const kind = cellKind(col)
                                    return (
                                      <div
                                        key={col}
                                        className="scr-card__foot-item"
                                      >
                                        <span className="scr-card__foot-label">{columnLabel(col)}</span>
                                        <span className="scr-card__foot-value">
                                          {formatScreenerNumber(raw, kind)}
                                        </span>
                                      </div>
                                    )
                                  })}
                                    </div>
                                  ) : null}
                                  {columns.includes('recent_headlines') ? (
                                    <div className="scr-source-card__news">
                                      <span>Recent headlines</span>
                                      {headlines.length ? headlines.map((headline, index) => (
                                        <a
                                          key={`${headline.url}-${index}`}
                                          href={headline.url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                        >
                                          {headline.title}
                                        </a>
                                      )) : <p>No recent headlines</p>}
                                    </div>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                          </article>
                            )}
                          </WithPerCardYahoo>
                        )
                      }
                      return (
                        <WithPerCardYahoo key={row.id || ticker}>
                          {({ yahooPriceEnabled, yahooToggle }) => (
                        <article className="scr-card">
                          <header className="scr-card__header">
                            <div className="scr-card__header-main">
                              <ScreenerRankBadge row={row} />
                            <a
                              className="scr-card__ticker-link"
                              href={yahooFinanceUrl(ticker)}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={`Open ${symbol} on Yahoo Finance`}
                            >
                              {symbol}
                            </a>
                            <HaltedSymbolDot halt={haltFor(symbol)} className="halt-dot--inline" />
                            </div>
                            <div className="scr-card__header-actions">
                              {yahooToggle}
                              <ScreenerWatchlistControl {...watchlistControlProps(ticker, status, 'card')} />
                            </div>
                          </header>
                          <div className="scr-card__face">
                            <YahooExtendedQuoteHero
                              ticker={ticker}
                              enabled={yahooPriceEnabled}
                              generation={yahooGeneration}
                              active={viewMode === 'cards'}
                              staggerMs={cardIndex * YAHOO_QUOTE_STAGGER_MS}
                              className="scr-card__hero-block scr-card__hero-block--yahoo"
                            >
                              <ScreenerCardHero
                                raw={heroRaw}
                                label={columnLabel(effectiveCardHeroField)}
                                previousPct={
                                  cellKind(effectiveCardHeroField) === 'percent'
                                    ? cardPctPrevByTicker[ticker.toUpperCase()]
                                    : null
                                }
                                liveFeed={liveFeed}
                              />
                            </YahooExtendedQuoteHero>
                            <div className="scr-card__foot">
                              {(() => {
                                const priceKeys = cardFaceMetricKeys(row, CARD_FACE_PRICE_KEYS, columns)
                                const volumeKeys = cardFaceMetricKeys(row, CARD_FACE_VOLUME_KEYS, columns)
                                const renderMetric = (col: string) => {
                                  const raw = row.cells?.[col]
                                  const kind = cellKind(col)
                                  const isPercent = kind === 'percent'
                                  return (
                                    <div key={col} className={`scr-card__foot-item${isPercent ? ' scr-card__foot-item--pct' : ''}`}>
                                      <span className="scr-card__foot-label">{cardMetricLabel(col)}</span>
                                      <span className={`scr-card__foot-value${isPercent ? ` scr-chg ${changeClass(raw)}` : ''}`}>
                                        {formatScreenerNumber(raw, kind)}
                                      </span>
                                    </div>
                                  )
                                }
                                return (
                                  <>
                                    {priceKeys.length ? (
                                      <div className="scr-card__foot-row">
                                        {priceKeys.map(renderMetric)}
                                      </div>
                                    ) : null}
                                    {volumeKeys.length ? (
                                      <div className="scr-card__foot-row">
                                        {volumeKeys.map(renderMetric)}
                                      </div>
                                    ) : null}
                                  </>
                                )
                              })()}
                            </div>
                          </div>
                        </article>
                          )}
                        </WithPerCardYahoo>
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
              <span className="scr-editor-title">{isStockCatalyst ? 'Visible columns' : 'Query'}</span>
              {!isStockCatalyst ? (
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
              ) : null}
            </div>
            <div className="scr-editor-body">
              {isStockCatalyst ? (
                <section className="scr-source-columns" aria-label="Stock Catalyst visible columns">
                  <p>
                    This screener mirrors the source tables. Choose which source columns appear
                    in table and card views.
                  </p>
                  <div className="scr-source-columns__list">
                    {STOCK_CATALYST_FIELDS.map(field => {
                      const checked = draftDefinition.columns.includes(field.key)
                      return (
                        <label key={field.key} className="scr-source-column">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={event => {
                              const current = draftDefinitionRef.current.columns
                              const nextColumns = event.target.checked
                                ? [...current, field.key]
                                : current.filter(col => col !== field.key)
                              commitDefinitionChange({
                                ...draftDefinitionRef.current,
                                columns: nextColumns,
                              })
                            }}
                          />
                          <span>
                            <strong>{field.label}</strong>
                            <small>{field.key}</small>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                  <p className="scr-hint">
                    Symbol and company name remain visible so every row can be identified.
                    Changes save automatically.
                  </p>
                </section>
              ) : editorMode === 'ai' ? (
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
                              commitDefinitionChange({
                                ...draftDefinitionRef.current,
                                columns: draftDefinitionRef.current.columns.filter(c => c !== col),
                              })
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
                        commitDefinitionChange({
                          ...draftDefinitionRef.current,
                          columns: [...draftDefinitionRef.current.columns, key],
                        })
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
                            const filters = [...(draftDefinitionRef.current.filters || [])]
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
                            const filters = [...(draftDefinitionRef.current.filters || [])]
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
                              const filters = [...(draftDefinitionRef.current.filters || [])]
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
                              const filters = [...(draftDefinitionRef.current.filters || [])]
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
                            commitDefinitionChange({
                              ...draftDefinitionRef.current,
                              filters: (draftDefinitionRef.current.filters || []).filter((_, i) => i !== idx),
                            })
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="scr-btn"
                      onClick={() => updateDraftFilters([...(draftDefinitionRef.current.filters || []), defaultFilter()])}
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
                          applyDraftLocally({ ...draftDefinitionRef.current, order_by: e.target.value || null })
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
                          applyDraftLocally({
                            ...draftDefinitionRef.current,
                            ascending: e.target.value === 'asc',
                          })
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
                          applyDraftLocally({
                            ...draftDefinitionRef.current,
                            limit: Number(e.target.value) || 50,
                          })
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
            {!isStockCatalyst ? (
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
                      const defn = coalesceDefinition(selected.definition)
                      setDraftDefinition(defn)
                      setDraftDsl(selected.dsl_text || definitionToDsl(defn))
                      setDslError('')
                    }}
                  >
                    Reset
                  </button>
                </>
              )}
              </div>
            ) : null}
          </aside>
        ) : null}
      </div>
    </div>
  )
}
