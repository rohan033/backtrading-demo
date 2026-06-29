import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type Time,
} from 'lightweight-charts'
import './Home.css'
import CompanyNewsPanel from '../../components/watchlist/CompanyNewsPanel'
import { ChatMarkdown } from '../../components/ui/chat-markdown'
import { formatBrokerMoney } from '../../lib/currency'
import { useCompanyNews } from '../../hooks/useCompanyNews'
import { formatNewsTimestamp, type CompanyNewsItem } from '../../lib/companyNews'
import { stripAiActionBlocks } from '../../lib/aiActionBlocks'
import { splitAssistantDisplayContent } from '../../lib/aiReplySummary'
import { finnhubSymbol } from '../../lib/marketResearch'
import { useMarketPreviewFeed } from '../../hooks/useMarketPreviewFeed'
import {
  defaultAccountEnv,
  pickWatchlistSymbolMatch,
  searchWatchlistSymbol,
  WATCHLIST_BROKER_OPTIONS,
  type WatchlistBroker,
  type WatchlistSymbolHit,
} from '../../lib/watchlistBrokers'
import {
  applyHomeChartViewport,
  candlesToVolumeData,
  mergeLiveTickIntoWatchlistCandles,
  type WatchlistSanitizedCandle,
} from '../../lib/watchlistCandles'
import { watchlistTickKey } from '../../lib/watchlists'
import { loadHomeChartHistory } from '../../lib/homeChartHistory'
import {
  buildHomeChartNewsMarkers,
  candleChartTimeRange,
  newsItemsAtChartTime,
} from '../../lib/homeChartNewsMarkers'
import {
  chartMarketTimeFormatter,
  chartSessionLabel,
  chartSessionMarketForBroker,
} from '../../lib/homeChartSessionShading'
import {
  buildResearchAgentPrompt,
  insertResearchTagMention,
  RESEARCH_CHAT_TAGS,
} from '../../lib/researchChatTags'
import {
  buildChartRangeAgentPrompt,
  buildChartRangeChatDraft,
  formatChartRangeLabel,
  type HomeChartChatContext,
} from '../../lib/homeChartChatContext'
import { useCursorAgentChat } from '../../lib/useCursorAgentChat'
import { useUrlState } from './useUrlState'
import HomeChartRangeSelector, { type ChartTimeRange } from '../../components/charts/HomeChartRangeSelector'
import HomeChartSessionShading from '../../components/charts/HomeChartSessionShading'
import {
  HomeEarningsPanel,
  HomeFilingsPanel,
  HomeInsiderPanel,
  HomeRecommendationsPanel,
  HomeSentimentPanel,
} from './HomeResearchPanels'
import HomeIndicesChart from './HomeIndicesChart'

type InfoTab = 'news' | 'filings' | 'earnings' | 'insider' | 'sentiment'

type HomeSelection = {
  broker: WatchlistBroker
  accountEnv: string
  tradingsymbol: string
  symboltoken: string
  exchange: string
  displayName?: string
  logo35x35?: string | null
  logo50x50?: string | null
  logo150x150?: string | null
}

function sortedUniqueCandles(candles: WatchlistSanitizedCandle[]): WatchlistSanitizedCandle[] {
  const byTime = new Map<number, WatchlistSanitizedCandle>()
  for (const candle of candles) {
    if (!Number.isFinite(candle.time)) continue
    byTime.set(candle.time, candle)
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time)
}

function HomeSymbolLogo({ selection }: { selection: HomeSelection }) {
  const [failed, setFailed] = useState(false)
  const src = selection.logo150x150 || selection.logo50x50 || selection.logo35x35
  const label = selection.displayName || selection.tradingsymbol

  if (src && !failed) {
    return (
      <img
        src={src}
        alt={label}
        className="hm-symbol-logo"
        onError={() => setFailed(true)}
      />
    )
  }

  return (
    <span className="hm-symbol-letter">
      {selection.tradingsymbol.charAt(0)}
    </span>
  )
}

function linePointsFromCandles(candles: WatchlistSanitizedCandle[], liveLtp: number | null): LineData[] {
  const byTime = new Map<number, number>()
  for (const candle of candles) {
    if (!Number.isFinite(candle.close) || candle.close <= 0) continue
    byTime.set(candle.time, candle.close)
  }
  if (liveLtp != null && Number.isFinite(liveLtp) && liveLtp > 0) {
    byTime.set(Math.floor(Date.now() / 1000 / 60) * 60, liveLtp)
  }
  return [...byTime.entries()]
    .sort(([a], [b]) => a - b)
    .map(([time, value]) => ({ time: time as LineData['time'], value }))
}

function HomeChart({
  selection,
  ltp,
  newsSymbol,
  showNewsMarkers,
  chartRange,
  onChartRangeChange,
  onAddRangeToChat,
  onClearChartRange,
}: {
  selection: HomeSelection
  ltp: number | null
  newsSymbol: string
  showNewsMarkers: boolean
  chartRange: ChartTimeRange | null
  onChartRangeChange: (range: ChartTimeRange | null) => void
  onAddRangeToChat: (range: ChartTimeRange) => void
  onClearChartRange: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const lineRef = useRef<ISeriesApi<'Line'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const newsByTimeRef = useRef<Map<number, CompanyNewsItem[]>>(new Map())
  const showNewsMarkersRef = useRef(showNewsMarkers)
  const userInteractedRef = useRef(false)
  const lastAutoFitKeyRef = useRef<string | null>(null)
  const [candles, setCandles] = useState<WatchlistSanitizedCandle[]>([])
  const [loading, setLoading] = useState(false)
  const [newsHover, setNewsHover] = useState<{
    time: number
    items: CompanyNewsItem[]
  } | null>(null)

  showNewsMarkersRef.current = showNewsMarkers

  const { items: newsItems, loading: newsLoading } = useCompanyNews(
    showNewsMarkers ? newsSymbol : null,
  )

  const tickKey = watchlistTickKey(selection.broker, selection.accountEnv, selection.symboltoken)
  const candleData = useMemo(
    () => sortedUniqueCandles(mergeLiveTickIntoWatchlistCandles(candles, ltp)),
    [candles, ltp],
  )
  const lineData = useMemo(() => linePointsFromCandles(candleData, ltp), [candleData, ltp])
  const volumeData = useMemo(() => candlesToVolumeData(candleData), [candleData])
  const hasVolume = volumeData.some(item => Number(item.value) > 0)
  const chartTimeRange = useMemo(() => candleChartTimeRange(candleData), [candleData])
  const sessionMarket = useMemo(
    () => chartSessionMarketForBroker(selection.broker),
    [selection.broker],
  )
  const newsMarkers = useMemo(
    () => buildHomeChartNewsMarkers(newsItems, chartTimeRange),
    [chartTimeRange, newsItems],
  )

  newsByTimeRef.current = newsMarkers.byTime

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    userInteractedRef.current = false
    lastAutoFitKeyRef.current = null
    const chart = createChart(el, {
      width: Math.max(1, el.clientWidth),
      height: Math.max(120, el.clientHeight),
      attributionLogo: false,
      layout: { background: { color: '#FFFFFF' }, textColor: '#9A9A9A' },
      grid: {
        vertLines: { color: '#F1F1F1' },
        horzLines: { color: '#F1F1F1' },
      },
      localization: {
        timeFormatter: chartMarketTimeFormatter(sessionMarket),
      },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.24 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    })
    chartRef.current = chart
    lineRef.current = null
    volumeRef.current = null

    const crosshairHandler = (param: { time?: Time; point?: { x: number; y: number } }) => {
      if (!showNewsMarkersRef.current || !param.time || !param.point) {
        setNewsHover(null)
        return
      }
      const time = typeof param.time === 'number' ? param.time : Number(param.time)
      if (!Number.isFinite(time)) {
        setNewsHover(null)
        return
      }
      const items = newsItemsAtChartTime(newsByTimeRef.current, time)
      setNewsHover(items.length ? { time, items } : null)
    }
    chart.subscribeCrosshairMove(crosshairHandler)

    const resize = () => {
      chart.applyOptions({
        width: Math.max(1, el.clientWidth),
        height: Math.max(120, el.clientHeight),
      })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(el)
    const markUserInteracted = () => { userInteractedRef.current = true }
    el.addEventListener('wheel', markUserInteracted, { passive: true })
    el.addEventListener('pointerdown', markUserInteracted)

    return () => {
      chart.unsubscribeCrosshairMove(crosshairHandler)
      el.removeEventListener('wheel', markUserInteracted)
      el.removeEventListener('pointerdown', markUserInteracted)
      observer.disconnect()
      chart.remove()
      chartRef.current = null
      lineRef.current = null
      volumeRef.current = null
    }
  }, [sessionMarket, tickKey])

  useEffect(() => {
    let cancelled = false
    setCandles([])
    setLoading(true)

    const symbol = {
      tickKey,
      watchlistId: 'home',
      broker: selection.broker,
      accountEnv: selection.accountEnv,
      tradingsymbol: selection.tradingsymbol,
      symboltoken: selection.symboltoken,
      exchange: selection.exchange,
    }

    void loadHomeChartHistory(symbol, {
      onRefresh: fresh => {
        if (cancelled || !fresh.length) return
        setCandles(sortedUniqueCandles(fresh))
      },
    })
      .then(next => {
        if (cancelled) return
        setCandles(sortedUniqueCandles(next))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [
    tickKey,
    selection.accountEnv,
    selection.broker,
    selection.exchange,
    selection.symboltoken,
    selection.tradingsymbol,
  ])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    if (!lineRef.current) {
      lineRef.current = chart.addLineSeries({
        color: '#2F80ED',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
      })
      volumeRef.current = chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: 'volume',
      })
      chart.priceScale('volume').applyOptions({
        scaleMargins: { top: 0.78, bottom: 0 },
      })
    }
    lineRef.current.setData(lineData)
    volumeRef.current?.setData(hasVolume ? volumeData : [])
    lineRef.current.setMarkers(showNewsMarkers ? newsMarkers.markers : [])
    const autoFitKey = `${tickKey}:line`
    if (lineData.length && !userInteractedRef.current && lastAutoFitKeyRef.current !== autoFitKey) {
      applyHomeChartViewport(chart, lineData.length)
      lastAutoFitKeyRef.current = autoFitKey
    }
  }, [hasVolume, lineData, newsMarkers.markers, showNewsMarkers, tickKey, volumeData])

  useEffect(() => {
    if (!showNewsMarkers) setNewsHover(null)
  }, [showNewsMarkers])

  return (
    <div className="hm-chart-body">
      {!selection ? null : (
        <>
          <div className="hm-chart-host-wrap">
            <div ref={hostRef} className="hm-chart-host" />
            <HomeChartSessionShading
              chartRef={chartRef}
              market={sessionMarket}
              fromTime={chartTimeRange?.from}
              toTime={chartTimeRange?.to}
              chartRevision={`${tickKey}:${lineData.length}`}
            />
            {showNewsMarkers && newsHover ? (
              <div className="hm-chart-news-tooltip" aria-live="polite">
                <div className="hm-chart-news-tooltip-time">
                  {formatNewsTimestamp(newsHover.time)}
                </div>
                {newsHover.items.slice(0, 2).map(item => (
                  <div key={item.id} className="hm-chart-news-tooltip-item">
                    <div className="hm-chart-news-tooltip-headline">{item.headline}</div>
                    <div className="hm-chart-news-tooltip-meta">{item.source}</div>
                  </div>
                ))}
                {newsHover.items.length > 2 ? (
                  <div className="hm-chart-news-tooltip-more">
                    +{newsHover.items.length - 2} more
                  </div>
                ) : null}
              </div>
            ) : null}
            <HomeChartRangeSelector
              chartRef={chartRef}
              activeRange={chartRange}
              onRangeChange={onChartRangeChange}
              onAddToChat={onAddRangeToChat}
            />
          </div>
          <div className="hm-chart-range-hint">
            <span>
              Shift+drag to select · right-click for options · Esc to clear
              {showNewsMarkers ? ' · hover flags for headlines' : ''}
            </span>
            <div className="hm-chart-session-legend" aria-hidden="true">
              <span className="hm-chart-session-legend-tz">
                {sessionMarket === 'US' ? 'ET' : 'IST'}
              </span>
              {(['closed', 'pre', 'open', 'after'] as const).map(session => (
                <span key={session} className="hm-chart-session-legend-item">
                  <span className={`hm-chart-session-swatch hm-chart-session-swatch--${session}`} />
                  {chartSessionLabel(session)}
                </span>
              ))}
            </div>
            {chartRange ? (
              <button
                type="button"
                className="hm-chart-range-hint-clear"
                onClick={onClearChartRange}
              >
                Clear selection
              </button>
            ) : null}
          </div>
          {!lineData.length && !loading ? (
            <span className="hm-chart-label">waiting for live price</span>
          ) : null}
          {loading && !lineData.length ? (
            <span className="hm-chart-label">loading chart…</span>
          ) : null}
          {showNewsMarkers && newsLoading && !newsItems.length ? (
            <span className="hm-chart-label hm-chart-label--news">loading news flags…</span>
          ) : null}
        </>
      )}
    </div>
  )
}

function InfoPlaceholder({ title, body }: { title: string; body: string }) {
  return (
    <div className="hm-info-placeholder">
      <strong>{title}</strong>
      {body}
    </div>
  )
}

const AI_DRAWER_WIDTH_KEY = 'home-ai-drawer-width'
const AI_DRAWER_COLLAPSED_KEY = 'home-ai-drawer-collapsed'
const INFO_PANEL_COLLAPSED_KEY = 'home-info-panel-collapsed'
const HOME_NEWS_MARKERS_KEY = 'home-chart-news-markers'
const AI_DRAWER_MIN = 280
const AI_DRAWER_MAX = 520
const AI_DRAWER_DEFAULT = 340

function loadDrawerBool(key: string, fallback = false) {
  try {
    const value = localStorage.getItem(key)
    if (value == null) return fallback
    return value === 'true'
  } catch {
    return fallback
  }
}

function loadDrawerWidth(fallback: number, min: number, max: number) {
  try {
    const value = Number(localStorage.getItem(AI_DRAWER_WIDTH_KEY))
    if (!Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, value))
  } catch {
    return fallback
  }
}

function HomeAiDrawer({
  collapsed,
  width,
  onToggle,
  onResizeStart,
  selection,
  chartChatContext,
  onClearChartContext,
  chatDraft,
  onChatDraftChange,
  onSendChat,
  onInsertTag,
  messages,
  sending,
  connected,
  statusText,
  error,
  onStop,
}: {
  collapsed: boolean
  width: number
  onToggle: () => void
  onResizeStart: (event: React.MouseEvent<HTMLDivElement>) => void
  selection: HomeSelection | null
  chartChatContext: HomeChartChatContext | null
  onClearChartContext: () => void
  chatDraft: string
  onChatDraftChange: (value: string) => void
  onSendChat: () => void
  onInsertTag: (mention: string) => void
  messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; streaming?: boolean }>
  sending: boolean
  connected: boolean
  statusText: string
  error: string
  onStop: () => void
}) {
  const chatEnabled = Boolean(selection) || Boolean(chartChatContext)
  if (collapsed) {
    return (
      <button
        type="button"
        className="hm-ai-drawer-tab"
        onClick={onToggle}
        aria-label="Open AI chat drawer"
        title="Open AI chat"
      >
        ‹
      </button>
    )
  }

  return (
    <aside className="hm-ai-drawer" style={{ width, minWidth: width }}>
      <div
        className="hm-ai-drawer-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize AI chat drawer"
        title="Drag to resize"
        onMouseDown={onResizeStart}
      />
      <button
        type="button"
        className="hm-ai-drawer-collapse"
        onClick={onToggle}
        aria-label="Collapse AI chat drawer"
      >
        ›
      </button>
      <header className="hm-ai-drawer-head">
        <div>
          <div className="hm-ai-drawer-title">AI chat</div>
          <div className="hm-ai-drawer-subtitle">
            {chartChatContext
              ? formatChartRangeLabel(chartChatContext)
              : selection
                ? `Research ${selection.displayName || selection.tradingsymbol}`
                : 'Select a stock or chart range'}
          </div>
        </div>
      </header>
      <div className="hm-ai-drawer-body">
        <div className="hm-chat-messages">
          {!messages.length ? (
            <div className="hm-chat-empty">
              Tag a section with @insidertrading, @earnings, @filings, @news, or @chartanalysis, then ask your question.
            </div>
          ) : (
            messages.map(message => {
              if (message.role === 'assistant') {
                const parts = splitAssistantDisplayContent(message.content, Boolean(message.streaming))
                const displayContent = stripAiActionBlocks(parts.body, Boolean(message.streaming))
                return (
                  <div
                    key={message.id}
                    className="hm-chat-bubble hm-chat-bubble--assistant"
                  >
                    {displayContent ? (
                      <ChatMarkdown content={displayContent} className="hm-chat-markdown" />
                    ) : message.streaming ? (
                      <span className="hm-chat-thinking">Thinking…</span>
                    ) : null}
                  </div>
                )
              }

              return (
                <div
                  key={message.id}
                  className={`hm-chat-bubble hm-chat-bubble--${message.role}`}
                >
                  {message.content}
                </div>
              )
            })
          )}
        </div>
        {error ? <p className="hm-chat-error">{error}</p> : null}
        <div className="hm-chat-footer">
          {chartChatContext ? (
            <div className="hm-chat-context-chip">
              <span className="hm-chat-context-chip__label">
                {formatChartRangeLabel(chartChatContext)}
              </span>
              <button
                type="button"
                className="hm-chat-context-chip__clear"
                onClick={onClearChartContext}
                aria-label="Clear chart range context"
              >
                ×
              </button>
            </div>
          ) : null}
          <div className="hm-chat-tags" role="group" aria-label="Research tags">
            {RESEARCH_CHAT_TAGS.map(tag => (
              <button
                key={tag.id}
                type="button"
                className="hm-chat-tag"
                title={tag.description}
                disabled={!chatEnabled || sending}
                onClick={() => onInsertTag(tag.mention)}
              >
                {tag.mention}
              </button>
            ))}
          </div>
          <div className="hm-chat-compose">
            <textarea
              className="hm-chat-input"
              rows={2}
              value={chatDraft}
              placeholder={
                chartChatContext
                  ? 'Add your question about this chart window…'
                  : selection
                    ? `@insidertrading Analyse ${selection.tradingsymbol}…`
                    : 'Shift+drag on chart, then right-click to add range…'
              }
              disabled={!chatEnabled || sending}
              onChange={event => onChatDraftChange(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  onSendChat()
                }
              }}
            />
            {sending ? (
              <button
                type="button"
                className="hm-chat-send hm-chat-send--stop"
                onClick={onStop}
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                className="hm-chat-send"
                disabled={!chatDraft.trim() || !chatEnabled || !connected}
                onClick={onSendChat}
              >
                Send
              </button>
            )}
          </div>
          <p className="hm-chat-status">{statusText}</p>
        </div>
      </div>
    </aside>
  )
}

export default function Home() {
  const { state, navigate } = useUrlState()
  const [query, setQuery] = useState('')
  const [broker, setBroker] = useState<WatchlistBroker>(() =>
    state.home_broker === 'angel' || state.home_broker === 'etoro' ? state.home_broker : 'etoro',
  )
  const [accountEnv, setAccountEnv] = useState(() =>
    state.home_env || defaultAccountEnv(
      state.home_broker === 'angel' || state.home_broker === 'etoro' ? state.home_broker : 'etoro',
    ),
  )
  const [selection, setSelection] = useState<HomeSelection | null>(() => {
    if (!state.home_symbol || !state.home_token) return null
    return {
      broker: state.home_broker === 'angel' ? 'angel' : 'etoro',
      accountEnv: state.home_env || defaultAccountEnv(state.home_broker === 'angel' ? 'angel' : 'etoro'),
      tradingsymbol: state.home_symbol,
      symboltoken: state.home_token,
      exchange: state.home_exchange || (state.home_broker === 'etoro' ? 'ETORO' : 'NSE'),
      displayName: state.home_name || undefined,
    }
  })
  const [results, setResults] = useState<WatchlistSymbolHit[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [infoTab, setInfoTab] = useState<InfoTab>('news')
  const [infoPanelCollapsed, setInfoPanelCollapsed] = useState(() =>
    loadDrawerBool(INFO_PANEL_COLLAPSED_KEY, false),
  )
  const [chatDraft, setChatDraft] = useState('')
  const [chartRange, setChartRange] = useState<ChartTimeRange | null>(null)
  const [chartChatContext, setChartChatContext] = useState<HomeChartChatContext | null>(null)
  const [showNewsMarkers, setShowNewsMarkers] = useState(() =>
    loadDrawerBool(HOME_NEWS_MARKERS_KEY, true),
  )
  const [aiDrawerCollapsed, setAiDrawerCollapsed] = useState(() =>
    loadDrawerBool(AI_DRAWER_COLLAPSED_KEY, false),
  )
  const [aiDrawerWidth, setAiDrawerWidth] = useState(() =>
    loadDrawerWidth(AI_DRAWER_DEFAULT, AI_DRAWER_MIN, AI_DRAWER_MAX),
  )
  const aiDrawerResizeRef = useRef<{ startX: number; startWidth: number } | null>(null)

  const {
    messages: agentMessages,
    health,
    connected,
    sending,
    error: chatError,
    sendMessage,
    stopMessage,
    hydrateMessages,
    resetAgent,
  } = useCursorAgentChat(!aiDrawerCollapsed, 'ask', null, undefined, true)

  const chatMessages = useMemo(
    () => agentMessages.filter(
      (message): message is typeof message & { role: 'user' | 'assistant' } =>
        message.role === 'user' || message.role === 'assistant',
    ),
    [agentMessages],
  )

  const chatStatusText = useMemo(() => {
    if (chatError && !connected) return chatError
    if (!connected) return 'Connecting to Strategy AI…'
    if (!health?.ready) {
      return health?.message || 'Set CURSOR_API_KEY in .cursor-api.env and restart the control plane'
    }
    return health.model ? `Connected · ${health.model}` : 'Connected via WebSocket'
  }, [chatError, connected, health])

  const { ltp, streamStatus } = useMarketPreviewFeed({
    broker: selection?.broker ?? broker,
    token: selection?.symboltoken,
    symbol: selection?.tradingsymbol,
    exchange: selection?.exchange,
    account_env: selection?.accountEnv ?? accountEnv,
    feed_mode: 'websocket',
    enabled: Boolean(selection),
  })

  const toggleInfoPanel = useCallback(() => {
    setInfoPanelCollapsed(prev => {
      const next = !prev
      try {
        localStorage.setItem(INFO_PANEL_COLLAPSED_KEY, String(next))
      } catch {
        // ignore storage errors
      }
      return next
    })
  }, [])

  const persistSelection = useCallback((next: HomeSelection | null) => {
    setSelection(next)
    if (!next) {
      navigate({
        home_symbol: '',
        home_token: '',
        home_exchange: '',
        home_name: '',
        home_broker: broker,
        home_env: accountEnv,
      })
      return
    }
    navigate({
      home_symbol: next.tradingsymbol,
      home_token: next.symboltoken,
      home_exchange: next.exchange,
      home_name: next.displayName || '',
      home_broker: next.broker,
      home_env: next.accountEnv,
    })
  }, [accountEnv, broker, navigate])

  useEffect(() => {
    if (!selection || selection.logo35x35 || selection.logo50x50 || selection.logo150x150) return
    let cancelled = false
    searchWatchlistSymbol(selection.broker, selection.tradingsymbol, selection.accountEnv)
      .then(hits => {
        if (cancelled) return
        const hit = pickWatchlistSymbolMatch(hits, selection.tradingsymbol)
        if (!hit) return
        setSelection(prev => {
          if (!prev || prev.symboltoken !== selection.symboltoken) return prev
          return {
            ...prev,
            displayName: prev.displayName || hit.instrumentDisplayName || hit.name || prev.tradingsymbol,
            logo35x35: hit.logo35x35 ?? null,
            logo50x50: hit.logo50x50 ?? null,
            logo150x150: hit.logo150x150 ?? null,
          }
        })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [selection])

  const selectHit = (hit: WatchlistSymbolHit) => {
    const next: HomeSelection = {
      broker,
      accountEnv,
      tradingsymbol: hit.tradingsymbol,
      symboltoken: hit.symboltoken,
      exchange: hit.exchange || (broker === 'etoro' ? 'ETORO' : 'NSE'),
      displayName: hit.instrumentDisplayName || hit.name || hit.tradingsymbol,
      logo35x35: hit.logo35x35 ?? null,
      logo50x50: hit.logo50x50 ?? null,
      logo150x150: hit.logo150x150 ?? null,
    }
    persistSelection(next)
    setResults([])
    setQuery('')
    setSearchError('')
  }

  const showIndices = useCallback(() => {
    persistSelection(null)
    setQuery('')
    setResults([])
    setSearchError('')
  }, [persistSelection])

  const handleBrokerChange = (nextBroker: WatchlistBroker) => {
    const nextEnv = defaultAccountEnv(nextBroker)
    setBroker(nextBroker)
    setAccountEnv(nextEnv)
    if (selection) {
      persistSelection({ ...selection, broker: nextBroker, accountEnv: nextEnv })
    } else {
      navigate({ home_broker: nextBroker, home_env: nextEnv })
    }
  }

  const tryQuickSelect = async () => {
    const q = query.trim()
    if (!q) return
    setSearching(true)
    setSearchError('')
    try {
      const hits = await searchWatchlistSymbol(broker, q, accountEnv)
      const hit = pickWatchlistSymbolMatch(hits, q)
      if (hit) {
        selectHit(hit)
        return
      }
      setResults(hits.slice(0, 20))
      setSearchError(hits.length ? 'Pick a match below.' : `No results for "${q}".`)
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'Search failed')
    } finally {
      setSearching(false)
    }
  }

  const sendChat = async () => {
    const text = chatDraft.trim()
    if (!text || sending) return
    if (!selection && !chartChatContext) return

    const prompt = chartChatContext
      ? buildChartRangeAgentPrompt(text, chartChatContext)
      : selection
        ? buildResearchAgentPrompt(text, selection.tradingsymbol)
        : ''
    if (!prompt.trim()) return

    const ok = await sendMessage(prompt, text)
    if (ok) setChatDraft('')
  }

  const toggleNewsMarkers = useCallback(() => {
    setShowNewsMarkers(prev => {
      const next = !prev
      try {
        localStorage.setItem(HOME_NEWS_MARKERS_KEY, String(next))
      } catch {
        // ignore storage errors
      }
      return next
    })
  }, [])

  const clearChartSelection = useCallback(() => {
    setChartRange(null)
  }, [])

  const clearChartChatContext = useCallback(() => {
    setChartChatContext(null)
    setChartRange(null)
  }, [])

  const addStockRangeToChat = useCallback((range: ChartTimeRange) => {
    if (!selection) return
    const context: HomeChartChatContext = {
      ...range,
      kind: 'stock',
      broker: selection.broker,
      accountEnv: selection.accountEnv,
      symbol: selection.tradingsymbol,
      displayName: selection.displayName,
    }
    setChartRange(range)
    setChartChatContext(context)
    setAiDrawerCollapsed(false)
    localStorage.setItem(AI_DRAWER_COLLAPSED_KEY, 'false')
    setChatDraft(buildChartRangeChatDraft(context))
  }, [selection])

  const addIndicesRangeToChat = useCallback((range: ChartTimeRange) => {
    const context: HomeChartChatContext = {
      ...range,
      kind: 'indices',
      broker,
      accountEnv,
      indices: ['SPX500', 'NSDQ100', 'DJ30'],
    }
    setChartRange(range)
    setChartChatContext(context)
    setAiDrawerCollapsed(false)
    localStorage.setItem(AI_DRAWER_COLLAPSED_KEY, 'false')
    setChatDraft(buildChartRangeChatDraft(context))
  }, [accountEnv, broker])

  useEffect(() => {
    hydrateMessages([])
    resetAgent(null)
    setChatDraft('')
    clearChartChatContext()
  }, [selection?.symboltoken, selection?.broker, hydrateMessages, resetAgent, clearChartChatContext])

  const insertChatTag = (mention: string) => {
    setChatDraft(prev => insertResearchTagMention(prev, mention))
  }

  const toggleAiDrawer = () => {
    setAiDrawerCollapsed(prev => {
      const next = !prev
      localStorage.setItem(AI_DRAWER_COLLAPSED_KEY, String(next))
      return next
    })
  }

  const startAiDrawerResize = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    aiDrawerResizeRef.current = { startX: event.clientX, startWidth: aiDrawerWidth }
    document.body.classList.add('hm-resizing')

    const handleMove = (moveEvent: MouseEvent) => {
      const active = aiDrawerResizeRef.current
      if (!active) return
      const next = Math.min(
        AI_DRAWER_MAX,
        Math.max(AI_DRAWER_MIN, active.startWidth + active.startX - moveEvent.clientX),
      )
      setAiDrawerWidth(next)
      localStorage.setItem(AI_DRAWER_WIDTH_KEY, String(next))
    }

    const handleUp = () => {
      aiDrawerResizeRef.current = null
      document.body.classList.remove('hm-resizing')
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
  }

  const streamBadgeClass = `hm-stream-badge hm-stream-badge--${
    streamStatus.tone === 'ok'
      ? 'ok'
      : streamStatus.tone === 'error'
        ? 'error'
        : streamStatus.tone === 'warn'
          ? 'warn'
          : 'idle'
  }`

  const newsSymbol = selection ? finnhubSymbol(selection.tradingsymbol) : ''

  return (
    <div className="hm-root">
      <div className="hm-toolbar">
        <div className="hm-search-wrap">
          <span className="hm-search-icon" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <circle cx="5.5" cy="5.5" r="4.5" stroke="currentColor" strokeWidth="1.3" />
              <line x1="9.1" y1="9.1" x2="12" y2="12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </span>
          <input
            type="search"
            className="hm-search-input"
            value={query}
            placeholder="Search stock ticker or name"
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') void tryQuickSelect()
            }}
          />
          {results.length ? (
            <div className="hm-search-results">
              {results.map(hit => (
                <button
                  type="button"
                  key={`${hit.symboltoken}-${hit.tradingsymbol}`}
                  className="hm-search-hit"
                  onClick={() => selectHit(hit)}
                >
                  <div className="hm-search-hit__sym">{hit.tradingsymbol}</div>
                  <div className="hm-search-hit__meta">
                    {hit.exchange} · {hit.instrumentDisplayName || hit.name || hit.tradingsymbol}
                  </div>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <select
          className="hm-broker-select"
          value={broker}
          onChange={event => handleBrokerChange(event.target.value as WatchlistBroker)}
          aria-label="Broker"
        >
          {WATCHLIST_BROKER_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>

        <button
          type="button"
          className={`hm-indices-btn${!selection ? ' hm-indices-btn--active' : ''}`}
          onClick={showIndices}
        >
          Indices
        </button>

        <button
          type="button"
          className="hm-search-btn"
          disabled={searching || !query.trim()}
          onClick={() => void tryQuickSelect()}
        >
          {searching ? 'Searching…' : 'Search'}
        </button>

        {searchError ? (
          <div className="hm-toolbar-meta">
            <div className="hm-toolbar-error">{searchError}</div>
          </div>
        ) : null}
      </div>

      <div className="hm-body-row">
        <div className={`hm-main${infoPanelCollapsed ? ' hm-main--info-collapsed' : ''}`}>
          <div className={`hm-top-row${selection ? '' : ' hm-top-row--full'}`}>
            <section className="hm-card hm-chart-card">
              {selection ? (
                <>
                  <div className="hm-chart-head">
                    <div className="hm-chart-head__main">
                      <HomeSymbolLogo selection={selection} />
                      <div className="hm-chart-copy">
                        <div className="hm-chart-title">
                          {selection.displayName || selection.tradingsymbol}
                        </div>
                        <div className="hm-chart-price">
                          {ltp != null ? formatBrokerMoney(selection.broker, ltp) : '—'}
                        </div>
                        <div className="hm-chart-subtitle">
                          {selection.tradingsymbol} · {broker === 'etoro' ? 'eToro' : 'Angel One'}
                        </div>
                      </div>
                    </div>
                    <div className="hm-chart-head__aside">
                      <button
                        type="button"
                        className={`hm-chart-toggle${showNewsMarkers ? ' hm-chart-toggle--active' : ''}`}
                        onClick={toggleNewsMarkers}
                        aria-pressed={showNewsMarkers}
                        title="Show company news flags on chart"
                      >
                        News flags
                      </button>
                      <span className={streamBadgeClass}>{streamStatus.label}</span>
                    </div>
                  </div>
                  <HomeChart
                    selection={selection}
                    ltp={ltp}
                    newsSymbol={newsSymbol}
                    showNewsMarkers={showNewsMarkers}
                    chartRange={chartRange}
                    onChartRangeChange={setChartRange}
                    onAddRangeToChat={addStockRangeToChat}
                    onClearChartRange={clearChartSelection}
                  />
                </>
              ) : (
                <HomeIndicesChart
                  broker={broker}
                  accountEnv={accountEnv}
                  chartRange={chartRange}
                  onChartRangeChange={setChartRange}
                  onAddRangeToChat={addIndicesRangeToChat}
                  onClearChartRange={clearChartSelection}
                />
              )}
            </section>

            {selection ? (
              <section className="hm-card hm-rec-card">
                <div className="hm-rec-card-head">
                  <div className="hm-rec-section-title">Analyst recommendation trends</div>
                  <div className="hm-rec-section-meta">{newsSymbol} · Finnhub</div>
                </div>
                <HomeRecommendationsPanel symbol={newsSymbol} />
              </section>
            ) : null}
          </div>

          {infoPanelCollapsed ? (
            <button
              type="button"
              className="hm-info-expand-tab"
              onClick={toggleInfoPanel}
              aria-label="Show research panel"
              title="Show research panel"
            >
              Research ▲
            </button>
          ) : (
            <section className="hm-card hm-info-card">
              <div className="hm-info-tabs" role="tablist" aria-label="Stock research">
                {([
                  ['news', 'News'],
                  ['filings', 'Filings'],
                  ['earnings', 'Earnings'],
                  ['insider', 'Insider'],
                  ['sentiment', 'Sentiment'],
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={infoTab === id}
                    className={`hm-info-tab${infoTab === id ? ' hm-info-tab--active' : ''}`}
                    onClick={() => setInfoTab(id)}
                  >
                    {label}
                  </button>
                ))}
                <button
                  type="button"
                  className="hm-info-collapse-btn"
                  onClick={toggleInfoPanel}
                  aria-label="Hide research panel"
                  title="Hide research panel"
                >
                  ▼
                </button>
              </div>
              <div className="hm-info-body">
                {!selection ? (
                  <InfoPlaceholder
                    title="No stock selected"
                    body="Pick a symbol from search to load company news, SEC filings, earnings calendar, insider trades, and filing sentiment."
                  />
                ) : infoTab === 'news' ? (
                  <CompanyNewsPanel symbol={newsSymbol} variant="minimal" showHeader={false} />
                ) : infoTab === 'filings' ? (
                  <HomeFilingsPanel symbol={newsSymbol} />
                ) : infoTab === 'earnings' ? (
                  <HomeEarningsPanel symbol={newsSymbol} />
                ) : infoTab === 'insider' ? (
                  <HomeInsiderPanel symbol={newsSymbol} />
                ) : (
                  <HomeSentimentPanel symbol={newsSymbol} />
                )}
              </div>
            </section>
          )}
        </div>

        <HomeAiDrawer
          collapsed={aiDrawerCollapsed}
          width={aiDrawerWidth}
          onToggle={toggleAiDrawer}
          onResizeStart={startAiDrawerResize}
          selection={selection}
          chartChatContext={chartChatContext}
          onClearChartContext={clearChartChatContext}
          chatDraft={chatDraft}
          onChatDraftChange={setChatDraft}
          onSendChat={() => { void sendChat() }}
          onInsertTag={insertChatTag}
          messages={chatMessages}
          sending={sending}
          connected={connected}
          statusText={chatStatusText}
          error={chatError}
          onStop={stopMessage}
        />
      </div>
    </div>
  )
}
