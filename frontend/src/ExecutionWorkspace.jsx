import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createChart } from 'lightweight-charts'

import {
  formatBrokerCompactMoney,
  formatBrokerPrice,
  formatBrokerSignedMoney,
  formatIndianNumber,
  formatPriceInput,
  isIndianBroker,
} from './lib/currency'
import { formatDbTimestamp } from './lib/datetime'
import StrategyScheduleSection from './components/StrategyScheduleSection'
import { buildLocalTradingDayOptions, loadTradingDayOptions } from './lib/tradingSchedule'
import { EXECUTION_SOURCE_USER } from './lib/executionSources'

const CONTROL_API = '/api/control'
const CONTROL_MARKET_WS = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/control/market`
const ACTIVE_DATA_PLANE_STATUSES = new Set(['running', 'starting'])
const MAX_PLANE_CONNECT_FAILURES = 3
const NOTIFY_ACTIONS = new Set([
  'BUY_ORDER_PLACED',
  'SELL_ORDER_PLACED',
  'ORDER_FILLED',
  'ORDER_REJECTED',
  'ORDER_CANCELLED',
  'POSITION_CLOSED',
  'TAKE_PROFIT_EXIT_PLACED',
  'STOP_LOSS_EXIT_PLACED',
])
const TOAST_DURATION_MS = 4500
const BROKER_OPTIONS = [
  { value: 'angel', label: 'Angel One' },
  { value: 'etoro', label: 'eToro' },
]
const ANGEL_FEED_OPTIONS = [
  { value: 'websocket', label: 'WebSocket (SmartAPI stream)' },
  { value: 'rest', label: 'REST poll (1s)' },
]
const DEFAULT_DATA_PLANE = {
  id: 'local-live-engine',
  label: 'angel-local-live-strategy-default',
  broker: 'angel',
  strategy_name: 'default',
  account_env: 'live',
  client_mode: 'standard',
  is_bracket_order_client: false,
  api_base_url: '/api/live',
  ws_url: `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/live`,
  status: 'unknown',
}

const TABS = [
  { id: 'strategy', label: 'Strategy' },
  { id: 'launch', label: 'Launch' },
  { id: 'chart', label: 'Chart' },
  { id: 'portfolio', label: 'Portfolio' },
  { id: 'orders', label: 'Order Management' },
  { id: 'events', label: 'Trading Events' },
  { id: 'history', label: 'History' },
]

const EMPTY_PLANE_STREAM = {
  connected: false,
  connectedAt: null,
  connectExhausted: false,
  ticks: {},
  tickHistory: {},
  lastTickAt: {},
  realtimeEvents: [],
}

const PRICE_STREAM_STALE_MS = 15000
const PRICE_STREAM_FIRST_TICK_MS = 10000
const PRICE_STREAM_STATUS_POLL_MS = 5000

const ExecutionContext = createContext(null)

export function useExecution() {
  const ctx = useContext(ExecutionContext)
  if (!ctx) {
    throw new Error('useExecution must be used within ExecutionProvider')
  }
  return ctx
}

export function ExecutionProvider({ children }) {
  const [activeTab, setActiveTab] = useState('strategy')
  const [executions, setExecutions] = useState([])
  const [dataPlanes, setDataPlanes] = useState([])
  const [selectedDataPlaneId, setSelectedDataPlaneId] = useState(null)
  const [selectedExecutionId, setSelectedExecutionId] = useState(null)
  const [showCreate, setShowCreate] = useState(false)
  const [duplicateDraft, setDuplicateDraft] = useState(null)
  const [controlledExecutions, setControlledExecutions] = useState([])
  const [controlledExecutionsLoading, setControlledExecutionsLoading] = useState(true)
  const [controlledExecutionsError, setControlledExecutionsError] = useState(null)
  const [selectedLaunchId, setSelectedLaunchId] = useState(null)
  const [planeStreams, setPlaneStreams] = useState({})
  const [toasts, setToasts] = useState([])

  const dataPlanesRef = useRef(dataPlanes)
  const planeSocketsRef = useRef({})
  const planeReconnectRef = useRef({})
  const planeFailuresRef = useRef({})
  const planeHandlerGenerationRef = useRef({})
  const planeConnectedUrlRef = useRef({})
  const toastIdRef = useRef(0)
  const notifiedToastKeysRef = useRef(new Set())
  const pushTradingToastRef = useRef(() => {})
  const planeCacheRef = useRef({})

  useEffect(() => {
    dataPlanesRef.current = dataPlanes
  }, [dataPlanes])

  const selectedDataPlane = useMemo(
    () => dataPlanes.find(engine => engine.id === selectedDataPlaneId) || dataPlanes[0] || null,
    [dataPlanes, selectedDataPlaneId],
  )

  const panelExecutions = useMemo(() => {
    const byId = new Map()
    for (const item of controlledExecutions) {
      const execution = normalizeControlledExecution(item)
      byId.set(execution.executor_id, execution)
    }
    for (const execution of executions) {
      const existing = byId.get(execution.executor_id)
      byId.set(execution.executor_id, existing ? mergeLiveExecution(existing, execution) : execution)
    }
    return Array.from(byId.values()).sort((a, b) => {
      const createdA = String(a.created_at || '')
      const createdB = String(b.created_at || '')
      if (createdA && createdB && createdA !== createdB) {
        return createdB.localeCompare(createdA)
      }
      const liveDelta = Number(Boolean(b.data_plane_port)) - Number(Boolean(a.data_plane_port))
      if (liveDelta !== 0) return liveDelta
      return String(a.label || a.executor_id).localeCompare(String(b.label || b.executor_id))
    })
  }, [controlledExecutions, executions])

  const selectedExecution = useMemo(
    () => panelExecutions.find(ex => ex.executor_id === selectedExecutionId) || null,
    [panelExecutions, selectedExecutionId],
  )

  const selectedExecutionLive = useMemo(() => {
    if (!selectedExecutionId) return null
    const registryExecution = selectedExecution
    const runtimeExecution = executions.find(ex => ex.executor_id === selectedExecutionId)
    if (!registryExecution && !runtimeExecution) return null
    if (!runtimeExecution) return registryExecution
    if (!registryExecution) return runtimeExecution
    return mergeLiveExecution(registryExecution, runtimeExecution)
  }, [selectedExecution, selectedExecutionId, executions])

  const isGlobalView = !selectedExecutionId

  const connectionPlane = useMemo(() => {
    const execution = selectedExecutionLive
    if (!execution?.data_plane_id || !execution?.ws_url) return null
    if (!['running', 'starting'].includes(execution.data_plane_status)) return null
    return {
      id: execution.data_plane_id,
      api_base_url: execution.api_base_url,
      ws_url: execution.ws_url,
      label: execution.data_plane_label,
      port: execution.data_plane_port,
      status: execution.data_plane_status,
    }
  }, [selectedExecutionLive])

  const liveApi = connectionPlane?.api_base_url || ''

  const selectedPlaneId = selectedExecutionLive?.data_plane_id || null
  const selectedStream = useMemo(
    () => getPlaneStream(planeStreams, selectedPlaneId),
    [planeStreams, selectedPlaneId],
  )
  const selectedTickKey = useMemo(
    () => planeTickKey(selectedPlaneId, selectedExecutionLive?.token || selectedExecution?.token),
    [selectedPlaneId, selectedExecutionLive?.token, selectedExecution?.token],
  )
  const wsConnected = selectedStream.connected
  const ticks = selectedStream.ticks
  const tickHistory = selectedStream.tickHistory
  const selectedTick = selectedTickKey ? ticks[selectedTickKey] : null

  const executionEvents = useMemo(() => {
    const filterId = selectedExecution?.executor_id || selectedExecutionId
    if (!filterId) return []
    return selectedStream.realtimeEvents.filter(event =>
      event.executor_id === filterId
      || event.details?.executor_id === filterId,
    )
  }, [selectedStream.realtimeEvents, selectedExecution, selectedExecutionId])

  const updatePlaneStream = useCallback((planeId, updater) => {
    setPlaneStreams(prev => {
      const current = prev[planeId] || planeCacheRef.current[planeId] || EMPTY_PLANE_STREAM
      const next = typeof updater === 'function' ? updater(current) : { ...current, ...updater }
      planeCacheRef.current[planeId] = next
      return { ...prev, [planeId]: next }
    })
  }, [])

  const pushTradingToast = useCallback((msg) => {
    const action = getEventAction(msg)
    if (!shouldNotifyAction(action)) return

    const dedupeKey = `${action}:${msg.order_id || ''}:${msg.executor_id || ''}:${msg.position_id || ''}`
    if (notifiedToastKeysRef.current.has(dedupeKey)) return
    notifiedToastKeysRef.current.add(dedupeKey)
    if (notifiedToastKeysRef.current.size > 200) {
      notifiedToastKeysRef.current = new Set([...notifiedToastKeysRef.current].slice(-100))
    }

    const tid = ++toastIdRef.current
    const detail = [
      msg.symbol,
      msg.order_id ? `order ${msg.order_id}` : null,
      msg.executor_id,
    ].filter(Boolean).join(' · ')

    setToasts(prev => [...prev.slice(-4), { id: tid, action, detail, msg }])
    setTimeout(() => {
      setToasts(prev => prev.filter(item => item.id !== tid))
    }, TOAST_DURATION_MS)
  }, [])

  useEffect(() => {
    pushTradingToastRef.current = pushTradingToast
  }, [pushTradingToast])

  const selectedLaunch = useMemo(
    () => controlledExecutions.find(item => item.execution_id === selectedLaunchId) || controlledExecutions[0] || null,
    [controlledExecutions, selectedLaunchId],
  )

  const refreshControlledExecutions = useCallback(async () => {
    setControlledExecutionsLoading(true)
    try {
      const res = await fetch(`${CONTROL_API}/executions`)
      if (!res.ok) {
        throw new Error(`Control plane returned HTTP ${res.status}`)
      }
      const data = await res.json()
      if (!data.status) {
        throw new Error(data.message || 'Failed to load saved strategies')
      }
      const rows = data.data || []
      setControlledExecutions(rows)
      setControlledExecutionsError(null)
      setSelectedLaunchId(prev => {
        if (prev && rows.some(item => item.execution_id === prev)) return prev
        return rows[0]?.execution_id || null
      })
    } catch (error) {
      setControlledExecutions([])
      setSelectedLaunchId(null)
      setControlledExecutionsError(
        error?.message || 'Could not reach the control plane. Start it with ./scripts/dev-cp.sh',
      )
    } finally {
      setControlledExecutionsLoading(false)
    }
  }, [])

  const refreshDataPlanes = useCallback(async () => {
    try {
      const res = await fetch(`${CONTROL_API}/engines`)
      const data = await res.json()
      const engines = data.status && data.data?.length
        ? filterActiveDataPlanes(data.data)
        : []
      dataPlanesRef.current = engines

      setDataPlanes(prev => {
        const prevKey = JSON.stringify(prev.map(engine => [engine.id, engine.status, engine.port, engine.updated_at]))
        const nextKey = JSON.stringify(engines.map(engine => [engine.id, engine.status, engine.port, engine.updated_at]))
        return prevKey === nextKey ? prev : engines
      })
      setSelectedDataPlaneId(prev => {
        if (prev && engines.some(engine => engine.id === prev)) return prev
        return engines[0]?.id || null
      })
    } catch {
      setDataPlanes([])
      setSelectedDataPlaneId(null)
    }
  }, [])

  const refreshExecutions = useCallback(async () => {
    const planes = filterActiveDataPlanes(dataPlanesRef.current)
    if (!planes.length) return
    const allExecutions = []

    await Promise.all(planes.map(async (plane) => {
      try {
        const res = await fetch(`${plane.api_base_url}/executors`)
        const data = await res.json()
        if (!data.status) return
        allExecutions.push(...(data.data || []).map(execution => normalizeExecution(execution, plane)))
      } catch {
        // Ignore unreachable data planes while polling.
      }
    }))

    setExecutions(prev => {
      if (!allExecutions.length && prev.length) return prev
      const prevKey = JSON.stringify(prev.map(ex => [ex.executor_id, ex.status, ex.is_in_position, ex.data_plane_status]))
      const nextKey = JSON.stringify(allExecutions.map(ex => [ex.executor_id, ex.status, ex.is_in_position, ex.data_plane_status]))
      return prevKey === nextKey ? prev : allExecutions
    })
  }, [])

  useEffect(() => {
    dataPlanesRef.current = dataPlanes
  }, [dataPlanes])

  useEffect(() => {
    refreshDataPlanes()
    refreshControlledExecutions()
    const intervalId = setInterval(refreshDataPlanes, 15000)
    return () => clearInterval(intervalId)
  }, [refreshDataPlanes, refreshControlledExecutions])

  const dataPlaneIdsKey = useMemo(
    () => dataPlanes.map(engine => `${engine.id}:${engine.status}:${engine.port}:${engine.ws_url}`).join('|'),
    [dataPlanes],
  )

  useEffect(() => {
    refreshExecutions()
    const intervalId = setInterval(refreshExecutions, 10000)
    return () => clearInterval(intervalId)
  }, [dataPlaneIdsKey, refreshExecutions])

  useEffect(() => {
    const activePlanes = filterActiveDataPlanes(dataPlanes)
    const activeIds = new Set(activePlanes.map(plane => plane.id))

    for (const planeId of Object.keys(planeSocketsRef.current)) {
      if (activeIds.has(planeId)) continue
      planeHandlerGenerationRef.current[planeId] = (planeHandlerGenerationRef.current[planeId] || 0) + 1
      clearTimeout(planeReconnectRef.current[planeId])
      planeSocketsRef.current[planeId]?.close()
      delete planeSocketsRef.current[planeId]
      delete planeReconnectRef.current[planeId]
      delete planeFailuresRef.current[planeId]
      delete planeConnectedUrlRef.current[planeId]
    }

    for (const plane of activePlanes) {
      if (!plane.ws_url) continue
      if ((planeFailuresRef.current[plane.id] || 0) >= MAX_PLANE_CONNECT_FAILURES) continue

      const planeId = plane.id
      const existingSocket = planeSocketsRef.current[planeId]
      if (
        existingSocket
        && [WebSocket.OPEN, WebSocket.CONNECTING].includes(existingSocket.readyState)
        && planeConnectedUrlRef.current[planeId] === plane.ws_url
      ) {
        continue
      }
      if (existingSocket) {
        planeHandlerGenerationRef.current[planeId] = (planeHandlerGenerationRef.current[planeId] || 0) + 1
        existingSocket.close()
        delete planeSocketsRef.current[planeId]
      }

      if (planeCacheRef.current[planeId]) {
        setPlaneStreams(prev => ({ ...prev, [planeId]: planeCacheRef.current[planeId] }))
      }

      const handlerGeneration = (planeHandlerGenerationRef.current[planeId] || 0) + 1
      planeHandlerGenerationRef.current[planeId] = handlerGeneration
      let cancelled = false

      const persistPlaneStream = (updater) => {
        updatePlaneStream(planeId, updater)
      }

      const handleMessage = (evt) => {
        const msg = JSON.parse(evt.data)

        if (msg.type === 'snapshot') {
          const snapshotExecutions = (msg.executors || []).map(execution =>
            normalizeExecution(execution, plane),
          )
          setExecutions(prev => {
            const others = prev.filter(ex => ex.data_plane_id !== planeId)
            const next = [...others, ...snapshotExecutions]
            const prevKey = JSON.stringify(prev.map(ex => [ex.executor_id, ex.status, ex.data_plane_id]))
            const nextKey = JSON.stringify(next.map(ex => [ex.executor_id, ex.status, ex.data_plane_id]))
            return prevKey === nextKey ? prev : next
          })
          return
        }

        if (msg.type === 'tick') {
          const tokenKey = normalizeTokenKey(msg.token)
          if (!tokenKey) return
          const ltp = Number(msg.ltp)
          if (!Number.isFinite(ltp) || ltp <= 0) return
          const streamKey = planeTickKey(planeId, tokenKey)
          const now = Date.now()
          persistPlaneStream(current => {
            const nextTicks = {
              ...current.ticks,
              [streamKey]: { symbol: msg.symbol, ltp, exchange: msg.exchange },
            }
            const existing = current.tickHistory[streamKey] || []
            const hadTick = Boolean(current.lastTickAt?.[streamKey])
            if (!hadTick) {
              console.info(
                '[PriceStream] first_tick plane=%s symbol=%s token=%s ltp=%s',
                planeId,
                msg.symbol,
                tokenKey,
                ltp,
              )
            }
            const nextHistory = {
              ...current.tickHistory,
              [streamKey]: appendTickPoint(existing, ltp),
            }
            return {
              ...current,
              ticks: nextTicks,
              tickHistory: nextHistory,
              lastTickAt: { ...current.lastTickAt, [streamKey]: now },
            }
          })
          return
        }

        if (msg.type === 'executor_status') {
          setExecutions(prev => prev.map(ex =>
            ex.executor_id === msg.executor_id
              ? { ...ex, status: msg.status, is_in_position: msg.is_in_position }
              : ex,
          ))
          return
        }

        if (['order', 'event', 'portfolio_status_update', 'portfolio_status_snapshot'].includes(msg.type)) {
          pushTradingToastRef.current(msg)
          persistPlaneStream(current => ({
            ...current,
            realtimeEvents: [msg, ...current.realtimeEvents].slice(0, 300),
          }))
        }
      }

      const connect = () => {
        if (cancelled || planeHandlerGenerationRef.current[planeId] !== handlerGeneration) return
        const wsUrl = resolvePlaneWsUrl(plane)
        const socket = new WebSocket(wsUrl)
        planeSocketsRef.current[planeId] = socket

        socket.onopen = () => {
          if (planeHandlerGenerationRef.current[planeId] !== handlerGeneration) return
          planeConnectedUrlRef.current[planeId] = plane.ws_url
          planeFailuresRef.current[planeId] = 0
          console.info('[PriceStream] ws_open plane=%s url=%s', planeId, wsUrl)
          persistPlaneStream(current => ({
            ...current,
            connected: true,
            connectedAt: Date.now(),
            connectExhausted: false,
          }))
        }

        socket.onerror = () => {
          socket.close()
        }

        socket.onclose = () => {
          if (planeHandlerGenerationRef.current[planeId] !== handlerGeneration) return
          const failures = (planeFailuresRef.current[planeId] || 0) + 1
          planeFailuresRef.current[planeId] = failures
          const stillActive = filterActiveDataPlanes(dataPlanesRef.current).some(item => item.id === planeId)
          const exhausted = stillActive && failures >= MAX_PLANE_CONNECT_FAILURES
          console.warn(
            '[PriceStream] ws_close plane=%s failures=%d exhausted=%s',
            planeId,
            failures,
            exhausted,
          )
          persistPlaneStream(current => ({
            ...current,
            connected: false,
            connectedAt: null,
            connectExhausted: exhausted,
          }))
          delete planeSocketsRef.current[planeId]
          if (!cancelled && stillActive && failures < MAX_PLANE_CONNECT_FAILURES) {
            planeReconnectRef.current[planeId] = setTimeout(connect, 3000)
          }
        }

        socket.onmessage = handleMessage
      }

      connect()
    }
  }, [dataPlaneIdsKey, updatePlaneStream])

  useEffect(() => () => {
    for (const planeId of Object.keys(planeSocketsRef.current)) {
      clearTimeout(planeReconnectRef.current[planeId])
      planeSocketsRef.current[planeId]?.close()
    }
    planeSocketsRef.current = {}
    planeReconnectRef.current = {}
    planeFailuresRef.current = {}
  }, [])

  const createExecution = () => {
    setDuplicateDraft(null)
    setShowCreate(true)
    setActiveTab('strategy')
  }

  const duplicateExecution = async (executionItem) => {
    if (!executionItem?.execution_id) return null
    try {
      const res = await fetch(`${CONTROL_API}/executions/${executionItem.execution_id}/duplicate-template`)
      const data = await res.json()
      if (!res.ok) {
        console.error('[DuplicateExecution] failed', data.detail || data.message)
        return null
      }
      setDuplicateDraft(data.data)
      setShowCreate(true)
      setActiveTab('strategy')
      return data.data
    } catch (err) {
      console.error('[DuplicateExecution] request failed', err)
      return null
    }
  }

  const onExecutionStopped = async (executionId) => {
    await refreshDataPlanes()
    await refreshControlledExecutions()
    await refreshExecutions()
    if (selectedDataPlaneId === executionId) {
      setSelectedDataPlaneId(null)
    }
  }

  const onExecutionCreated = async (executionId) => {
    setShowCreate(false)
    setDuplicateDraft(null)
    await refreshControlledExecutions()
    setSelectedLaunchId(executionId)
    setActiveTab('launch')
  }

  const onExecutionStarted = async (engine, executor) => {
    await refreshDataPlanes()
    await refreshControlledExecutions()
    await refreshExecutions()
    if (engine?.id) {
      setSelectedDataPlaneId(engine.id)
    }
    if (executor?.executor_id) {
      setSelectedExecutionId(executor.executor_id)
    }
    setActiveTab('chart')
  }

  const value = {
    activeTab,
    setActiveTab,
    panelExecutions,
    selectedExecution,
    selectedExecutionLive,
    selectedExecutionId,
    setSelectedExecutionId,
    isGlobalView,
    connectionPlane,
    selectedDataPlane,
    selectedDataPlaneId,
    setSelectedDataPlaneId,
    liveApi,
    wsConnected,
    ticks,
    tickHistory,
    selectedTick,
    executionEvents,
    planeStreams,
    controlledExecutions,
    controlledExecutionsLoading,
    controlledExecutionsError,
    selectedLaunch,
    selectedLaunchId,
    setSelectedLaunchId,
    dataPlanes,
    showCreate,
    setShowCreate,
    duplicateDraft,
    setDuplicateDraft,
    createExecution,
    duplicateExecution,
    onExecutionStopped,
    onExecutionCreated,
    onExecutionStarted,
    refreshControlledExecutions,
    refreshExecutions,
    refreshDataPlanes,
  }

  return (
    <ExecutionContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2">
        {toasts.map(toast => (
          <TradingToast key={toast.id} toast={toast} />
        ))}
      </div>
    </ExecutionContext.Provider>
  )
}

function TradingToast({ toast }) {
  const tone = toastTone(toast.action)
  return (
    <div className={`toast-enter px-4 py-3 rounded-lg text-xs font-semibold shadow-xl border backdrop-blur-sm ${tone.className}`}>
      <div className="flex items-start gap-2">
        <span className="text-base leading-none mt-0.5">{tone.icon}</span>
        <div className="min-w-0">
          <div>{formatActionLabel(toast.action)}</div>
          {toast.detail ? (
            <div className="text-[10px] opacity-80 font-normal mt-1 truncate">{toast.detail}</div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function ExecutionSidePanel({
  dataPlanes,
  selectedDataPlaneId,
  onSelectDataPlane,
  executions,
  selectedExecutionId,
  isGlobalView,
  planeStreams,
  connectionPlane,
  onSelectGlobal,
  onSelect,
  onCreate,
}) {
  const livePlaneCount = Object.values(planeStreams).filter(stream => stream.connected).length
  const selectedStream = getPlaneStream(
    planeStreams,
    executions.find(ex => ex.executor_id === selectedExecutionId)?.data_plane_id,
  )

  return (
    <aside className="w-[310px] bg-secondary border-r border-border flex flex-col shrink-0">
      <div className="p-4 border-b border-border">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-xs font-bold uppercase tracking-[1.5px]">Executions</h2>
            <p className="text-[9px] text-text-secondary mt-1">broker-stock-strategy</p>
          </div>
          <button
            onClick={onCreate}
            className="w-8 h-8 rounded-full bg-accent text-white text-lg leading-none hover:bg-accent/80"
            title="Create execution"
          >
            +
          </button>
        </div>
        <div className="flex items-center gap-2 text-[9px] text-text-secondary">
          <span className={`w-2 h-2 rounded-full ${isGlobalView ? 'bg-accent' : selectedStream.connected ? 'bg-green' : 'bg-red'}`} />
          {isGlobalView
            ? 'Global view · control plane database'
            : selectedStream.connected
              ? `Live stream · port ${connectionPlane?.port || '-'}`
              : connectionPlane?.port
                ? 'Execution view · reconnecting live stream'
                : 'Execution view · offline (database only)'}
          {livePlaneCount > 0 ? <span className="ml-1">· {livePlaneCount} live server{livePlaneCount === 1 ? '' : 's'}</span> : null}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-2">
        <div className="mb-4">
          <label className="text-[8px] uppercase tracking-widest text-text-secondary block mb-1">Data Plane</label>
          <select
            value={selectedDataPlaneId || ''}
            onChange={event => onSelectDataPlane(event.target.value)}
            className="w-full bg-card border border-border rounded px-2 py-2 text-[10px] outline-none focus:border-accent"
          >
            {dataPlanes.length ? dataPlanes.map(engine => (
              <option key={engine.id} value={engine.id}>
                {engine.label || engine.id} ({engine.port || '-'}, {envLabel(engine.account_env)})
              </option>
            )) : (
              <option value="">No running data planes</option>
            )}
          </select>
        </div>

        <button
          onClick={onSelectGlobal}
          className={`w-full text-left p-3 rounded border transition-colors ${
            isGlobalView
              ? 'bg-accent/10 border-accent'
              : 'bg-card border-border hover:border-accent/50'
          }`}
        >
          <div className="text-[11px] font-bold">Global View</div>
          <div className="text-[9px] text-text-secondary mt-1">
            All orders, events, and history from the control plane database
          </div>
        </button>

        {executions.map(ex => {
          const stream = getPlaneStream(planeStreams, ex.data_plane_id)
          return (
          <button
            key={`${ex.data_plane_id}:${ex.executor_id}`}
            onClick={() => onSelect(ex.executor_id)}
            className={`w-full text-left p-3 rounded border transition-colors ${
              selectedExecutionId === ex.executor_id
                ? 'bg-accent/10 border-accent'
                : 'bg-card border-border hover:border-accent/50'
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[11px] font-bold truncate">{ex.label}</div>
                <div className="text-[9px] text-text-secondary mt-1 truncate">
                  {ex.executor_id} · {envLabel(ex.account_env)}
                </div>
                <div className="text-[9px] text-text-secondary mt-1 truncate">
                  {ex.symbol || '-'} · {instrumentLabel(ex.broker)} {ex.token || '-'}
                </div>
                <div className="text-[9px] text-text-secondary mt-1 truncate">
                  server :{ex.data_plane_port || '-'} · {ex.data_plane_status || 'unknown'}
                  {stream.connected ? ' · live ws' : ex.data_plane_port ? ' · ws offline' : ''}
                </div>
                {ex.log_file ? (
                  <div className="text-[9px] text-text-secondary mt-1 truncate font-mono" title={ex.log_file}>
                    log {ex.log_file}
                  </div>
                ) : null}
              </div>
              <StatusBadge status={ex.status} />
            </div>
            <div className="grid grid-cols-3 gap-2 mt-3 text-[9px] text-text-secondary">
              <Metric label="TP" value={`${ex.long_percent ?? '-'}%`} />
              <Metric label="SL" value={`${ex.short_percent ?? '-'}%`} />
              <Metric label="Cap" value={formatBrokerCompactMoney(ex.broker, ex.max_available_capital)} />
            </div>
          </button>
          )
        })}

        {!executions.length && (
          <div className="p-4 border border-dashed border-border rounded text-center">
            <p className="text-xs text-text-secondary mb-3">No executions registered yet. Use Global View for persisted history.</p>
            <button onClick={onCreate} className="px-3 py-1.5 bg-accent text-white rounded text-[10px] font-bold">
              Create Execution
            </button>
          </div>
        )}
      </div>
    </aside>
  )
}

function WorkspaceHeader({ execution, isGlobalView, dataPlane, wsConnected, liveApi }) {
  return (
    <div className="px-5 py-3 bg-secondary border-b border-border flex items-center justify-between shrink-0">
      <div>
        <div className="text-sm font-bold">
          {isGlobalView ? 'Global View' : (execution?.label || 'No execution selected')}
        </div>
        <div className="text-[10px] text-text-secondary mt-0.5">
          {isGlobalView
            ? 'All persisted orders, events, and history from the control plane database'
            : execution
              ? `${execution.symbol} · ${instrumentLabel(execution.broker)} ${execution.token || '-'} · ${execution.strategy_name}`
              : 'Select an execution from the left panel'}
          {!isGlobalView ? (
            <>
              <span className="ml-2">· Live server :{dataPlane?.port || '-'}</span>
              {liveApi ? <span className="ml-2">· {liveApi}</span> : null}
            </>
          ) : null}
          {execution?.log_file ? (
            <div className="mt-1 font-mono break-all">Log: {execution.log_file}</div>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {!isGlobalView && <EnvBadge env={execution?.account_env || dataPlane?.account_env} />}
        {!isGlobalView && (
          <span className="text-[9px] bg-card border border-border px-2 py-1 rounded font-bold">
            {(execution?.is_bracket_order_client || dataPlane?.is_bracket_order_client) ? 'BRACKET' : 'FEED TP/SL'}
          </span>
        )}
        {execution && execution.is_in_position && (
          <span className="text-[9px] bg-accent/20 text-accent px-2 py-1 rounded font-bold">IN POSITION</span>
        )}
        {isGlobalView ? (
          <span className="text-[9px] px-2 py-1 rounded font-bold bg-accent/20 text-accent">DATABASE</span>
        ) : (
          <span className={`text-[9px] px-2 py-1 rounded font-bold ${wsConnected ? 'bg-green/20 text-green' : 'bg-red/20 text-red'}`}>
            {wsConnected ? 'LIVE' : 'OFFLINE'}
          </span>
        )}
      </div>
    </div>
  )
}

function TabBar({ activeTab, setActiveTab }) {
  return (
    <div className="flex items-center gap-1 px-4 py-2 bg-primary border-b border-border shrink-0">
      {TABS.map(tab => (
        <button
          key={tab.id}
          onClick={() => setActiveTab(tab.id)}
          className={`px-3 py-1.5 rounded text-[10px] font-bold transition-colors ${
            activeTab === tab.id
              ? 'bg-accent text-white'
              : 'bg-card text-text-secondary hover:text-text-primary'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

export function StrategyChartPanel({ execution, planeStreams, selectedTick }) {
  const stream = getPlaneStream(planeStreams, execution?.data_plane_id)
  const resolvedStream = useMemo(
    () => (execution ? resolveExecutionStream(stream, execution) : { tickHistory: [], tick: null, streamKey: '' }),
    [stream, execution],
  )
  const ltp = selectedTick?.ltp ?? resolvedStream.tick?.ltp ?? null
  const chartSeries = useMemo(
    () => (execution ? buildChartSeries(resolvedStream.tickHistory, execution, ltp) : []),
    [resolvedStream.tickHistory, execution, ltp],
  )
  const isStreaming = Boolean(execution?.ws_url)
    && ['running', 'starting'].includes(String(execution?.data_plane_status || '').toLowerCase())
  const nowMs = useNow(isStreaming ? PRICE_STREAM_STATUS_POLL_MS : null)
  const priceStreamStatus = useMemo(
    () => resolveExecutionPriceStreamStatus({
      isStreaming,
      stream,
      streamKey: resolvedStream.streamKey,
      nowMs,
    }),
    [isStreaming, stream, resolvedStream.streamKey, nowMs],
  )

  useEffect(() => {
    if (!execution?.executor_id) return
    console.info(
      '[PriceStream] status=%s label=%s executor=%s plane=%s streamKey=%s connected=%s lastTickAge=%s',
      priceStreamStatus.status,
      priceStreamStatus.label,
      execution.executor_id,
      execution.data_plane_id || '-',
      resolvedStream.streamKey || '-',
      stream.connected,
      priceStreamStatus.lastTickAgeSec ?? 'none',
    )
  }, [
    priceStreamStatus.status,
    priceStreamStatus.label,
    priceStreamStatus.lastTickAgeSec,
    execution?.executor_id,
    execution?.data_plane_id,
    resolvedStream.streamKey,
    stream.connected,
  ])

  if (!execution) {
    return (
      <div className="flex min-h-[360px] items-center justify-center rounded-lg border border-border bg-card p-8">
        <EmptyState title="No chart data" body="Select a strategy execution to view the chart." />
      </div>
    )
  }

  const realtimeEvents = stream.realtimeEvents.filter(event =>
    event.executor_id === execution.executor_id
    || event.details?.executor_id === execution.executor_id,
  )

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3.5">
        <div>
          <h3 className="text-[13px] font-semibold">Live chart</h3>
          <PriceStreamStatusLine status={priceStreamStatus} />
        </div>
        <div className="text-right">
          <div className="text-sm font-bold">{execution.symbol || '—'}</div>
          <div className="font-mono text-xl font-bold text-text-primary">
            {ltp != null
              ? formatBrokerPrice(execution.broker, ltp)
              : execution.close_price != null
                ? formatBrokerPrice(execution.broker, execution.close_price)
                : '—'}
          </div>
        </div>
      </div>
      <div className="p-4 min-w-0">
        {isStreaming ? (
          <LiveExecutionChart
            execution={execution}
            data={chartSeries}
            realtimeEvents={realtimeEvents}
          />
        ) : (
          <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-border bg-secondary/20 px-6 text-center">
            <p className="text-sm font-semibold">Chart unavailable</p>
            <p className="mt-2 max-w-sm text-xs text-text-secondary">
              Deploy this strategy to start live price streaming.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

export function ChartTab({ executions, planeStreams, selectedExecutionId }) {
  const liveExecutions = useMemo(
    () => executions.filter(execution =>
      execution?.ws_url
      && ['running', 'starting'].includes(String(execution.data_plane_status || '').toLowerCase()),
    ),
    [executions],
  )
  const nowMs = useNow(liveExecutions.length ? PRICE_STREAM_STATUS_POLL_MS : null)

  if (!liveExecutions.length) {
    return (
      <EmptyState
        title="No live chart streams"
        body="Start one or more executions from the Strategy or Launch tab to stream chart data."
      />
    )
  }

  return (
    <div className="p-4 space-y-4">
      {liveExecutions.map(execution => {
        const stream = getPlaneStream(planeStreams, execution.data_plane_id)
        const resolvedStream = resolveExecutionStream(stream, execution)
        const { tickHistory, tick: streamTick, streamKey } = resolvedStream
        const liveLtp = streamTick?.ltp ?? null
        const chartSeries = buildChartSeries(tickHistory, execution, liveLtp)
        const priceStreamStatus = resolveExecutionPriceStreamStatus({
          isStreaming: true,
          stream,
          streamKey,
          nowMs,
        })
        const realtimeEvents = stream.realtimeEvents.filter(event =>
          event.executor_id === execution.executor_id
          || event.details?.executor_id === execution.executor_id,
        )
        const selected = execution.executor_id === selectedExecutionId

        return (
          <div
            key={`${execution.data_plane_id}:${execution.executor_id}`}
            className={`rounded border ${selected ? 'border-accent bg-accent/5' : 'border-border bg-card'}`}
          >
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border/60">
              <div>
                <div className="text-sm font-bold">{execution.label || execution.executor_id}</div>
                <div className="text-[10px] text-text-secondary mt-0.5">
                  {execution.symbol || '-'} · server :{execution.data_plane_port || '-'}
                  {execution.created_at ? ` · created ${formatDbTimestamp(execution.created_at)}` : ''}
                </div>
                <PriceStreamStatusLine status={priceStreamStatus} />
              </div>
              {selected ? (
                <span className="text-[10px] px-2 py-1 rounded bg-accent/15 text-accent font-bold">Selected</span>
              ) : null}
            </div>
            <div className="p-4 space-y-4">
              <LiveExecutionChart
                execution={execution}
                data={chartSeries}
                realtimeEvents={realtimeEvents}
              />
              <ExecutionLevels execution={execution} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function LiveExecutionChart({ execution, data, realtimeEvents }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const priceLinesRef = useRef([])
  const lastPointRef = useRef(null)
  const chartData = useMemo(() => sanitizeChartSeries(data), [data])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    let chart = null
    let resizeObserver = null
    let cancelled = false

    const mountChart = () => {
      if (cancelled || !containerRef.current) return
      const width = containerRef.current.clientWidth
      if (width <= 0) {
        requestAnimationFrame(mountChart)
        return
      }

      chart = createChart(containerRef.current, {
        width,
        height: 420,
        layout: { background: { color: '#111d28' }, textColor: '#8899a6' },
        grid: { vertLines: { color: '#1a2733' }, horzLines: { color: '#1a2733' } },
        timeScale: { timeVisible: true, secondsVisible: true, borderColor: '#2a3f52' },
        rightPriceScale: { borderColor: '#2a3f52', autoScale: true },
      })
      const series = chart.addLineSeries({ color: '#1da1f2', lineWidth: 2, priceLineVisible: false })
      chartRef.current = chart
      seriesRef.current = series
      lastPointRef.current = null

      resizeObserver = new ResizeObserver(() => {
        if (!containerRef.current || !chartRef.current) return
        const nextWidth = containerRef.current.clientWidth
        if (nextWidth > 0) chartRef.current.resize(nextWidth, 420)
      })
      resizeObserver.observe(containerRef.current)
    }

    mountChart()

    return () => {
      cancelled = true
      resizeObserver?.disconnect()
      chart?.remove()
      chartRef.current = null
      seriesRef.current = null
      lastPointRef.current = null
    }
  }, [execution.executor_id])

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return
    const series = seriesRef.current
    const chart = chartRef.current
    if (!chartData.length) {
      series.setData([])
      lastPointRef.current = null
      return
    }

    const lastPoint = chartData[chartData.length - 1]
    const previousPoint = lastPointRef.current
    if (previousPoint && lastPoint.time === previousPoint.time) {
      series.update(lastPoint)
    } else if (
      previousPoint
      && lastPoint.time > previousPoint.time
      && chartData[chartData.length - 2]?.time === previousPoint.time
    ) {
      series.update(lastPoint)
    } else {
      series.setData(chartData)
    }
    lastPointRef.current = lastPoint
    chart.timeScale().fitContent()
  }, [chartData])

  useEffect(() => {
    if (!seriesRef.current) return
    const series = seriesRef.current
    priceLinesRef.current.forEach(line => series.removePriceLine(line))
    priceLinesRef.current = getPriceLines(execution).map(line => series.createPriceLine(line))
    chartRef.current?.timeScale().fitContent()
  }, [execution, chartData.length])

  useEffect(() => {
    if (!seriesRef.current || !chartData.length) return
    const markers = buildTradeMarkers(realtimeEvents, execution.executor_id, chartData)
    try {
      seriesRef.current.setMarkers(markers)
    } catch (error) {
      console.warn('[LiveExecutionChart] Failed to set markers', error)
    }
  }, [chartData, execution.executor_id, realtimeEvents])

  return <div ref={containerRef} className="w-full min-w-0 h-[420px]" />
}

function PortfolioTab({ ticks, liveApi, execution }) {
  const [holdings, setHoldings] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!liveApi) {
      setHoldings([])
      setLoading(false)
      return undefined
    }
    setLoading(true)
    fetch(`${liveApi}/portfolio`)
      .then(res => res.json())
      .then(data => { if (data.status) setHoldings(data.data || []) })
      .catch(() => setHoldings([]))
      .finally(() => setLoading(false))
  }, [liveApi])

  if (!liveApi) {
    return <EmptyState title="No live server connected" body="Select a running execution to view its broker portfolio." />
  }
  if (loading) return <EmptyState title="Loading portfolio" body={`Fetching holdings from ${liveApi}`} />
  if (!holdings.length) return <EmptyState title="No portfolio data" body="No holdings were returned by the active broker client." />

  return (
    <div className="p-4">
      <DataTable
        columns={['Symbol', 'Exchange', 'Qty', 'LTP', 'P&L']}
        rows={holdings.map(holding => {
          const holdingTickKey = execution?.data_plane_id
            ? planeTickKey(execution.data_plane_id, holding.symboltoken)
            : normalizeTokenKey(holding.symboltoken)
          const liveLtp = ticks[holdingTickKey]?.ltp
          const ltp = Number(liveLtp || holding.ltp || 0)
          const avg = Number(holding.averageprice || 0)
          const qty = Number(holding.quantity || 0)
          const pnl = (ltp - avg) * qty
          return [
            holding.tradingsymbol,
            holding.exchange,
            isIndianBroker(execution?.broker)
              ? formatIndianNumber(qty, 0)
              : qty,
            formatBrokerPrice(execution?.broker, ltp),
            <span className={pnl >= 0 ? 'text-green' : 'text-red'} key="pnl">
              {formatBrokerSignedMoney(execution?.broker, pnl)}
            </span>,
          ]
        })}
      />
    </div>
  )
}

function HighlightMetricCard({ label, value, tone = 'default', mono = true, size = 'lg' }) {
  const valueToneClass = tone === 'profit'
    ? 'text-green'
    : tone === 'loss'
      ? 'text-red'
      : tone === 'accent'
        ? 'text-accent'
        : 'text-text-primary'
  const sizeClass = size === 'xl' ? 'text-3xl' : size === 'lg' ? 'text-2xl' : 'text-xl'

  return (
    <div className="rounded-lg border border-border bg-card px-4 py-4">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">{label}</div>
      <div className={`font-bold leading-tight ${mono ? 'font-mono' : ''} ${sizeClass} ${valueToneClass}`}>
        {value}
      </div>
    </div>
  )
}

function ConnectionEndpointCard({ label, value, pending = false }) {
  const displayValue = value || (pending ? 'Created when live server starts' : '—')

  return (
    <div className="rounded-lg border border-border bg-card px-4 py-4">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-secondary">{label}</div>
      <div className="break-all font-mono text-base font-bold leading-snug text-text-primary">{displayValue}</div>
    </div>
  )
}

export function ServerInfoPanel({ port, apiBaseUrl, wsUrl, logFile, pending = false, hideTitle = false }) {
  return (
    <div className="space-y-3">
      {!hideTitle ? (
        <h3 className="text-xs font-bold uppercase tracking-[1.5px]">Runtime connection</h3>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <HighlightMetricCard label="Port" value={port || '—'} tone="accent" />
        <ConnectionEndpointCard label="API" value={apiBaseUrl} pending={pending && !apiBaseUrl} />
        {wsUrl ? <ConnectionEndpointCard label="WebSocket" value={wsUrl} /> : null}
        <ConnectionEndpointCard label="Log file" value={logFile} pending={pending && !logFile} />
      </div>
    </div>
  )
}

function StrategyParametersPanel({ execution, onRefresh }) {
  const closePrice = execution.close_price != null
    ? formatBrokerPrice(execution.broker, execution.close_price)
    : '—'
  const takeProfit = execution.long_percent != null ? `${execution.long_percent}%` : '—'
  const stopLoss = execution.short_percent != null ? `${execution.short_percent}%` : '—'
  const entryThreshold = execution.initial_threshold != null ? `${execution.initial_threshold}%` : '—'
  const maxCapital = execution.max_available_capital != null
    ? formatBrokerCompactMoney(execution.broker, execution.max_available_capital)
    : '—'
  const clientMode = execution.is_bracket_order_client ? 'Bracket orders' : 'Feed TP/SL'

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold uppercase tracking-[1.5px]">Strategy parameters</h3>
        <button onClick={onRefresh} className="text-[10px] text-accent hover:text-text-primary">Refresh</button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <HighlightMetricCard label="Take profit" value={takeProfit} tone="profit" size="xl" />
        <HighlightMetricCard label="Stop loss" value={stopLoss} tone="loss" size="xl" />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <HighlightMetricCard label="Close price" value={closePrice} tone="default" />
        <HighlightMetricCard label="Entry threshold" value={entryThreshold} tone="default" />
        <HighlightMetricCard label="Max capital" value={maxCapital} tone="default" />
        <HighlightMetricCard label="Client mode" value={clientMode} tone="default" mono={false} />
      </div>
    </div>
  )
}

export function StrategyTab({ execution, latestTick, liveApi, onCreate, onRefresh, includeServerInfo = true }) {
  if (!execution) {
    return (
      <EmptyState
        title="No strategy execution"
        body="Create a broker-stock-strategy execution to start monitoring strategy state."
        action={<button onClick={onCreate} className="px-4 py-2 bg-accent text-white rounded text-xs font-bold">New strategy</button>}
      />
    )
  }

  return (
    <div className="p-4 space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Environment" value={envLabel(execution.account_env)} colorClass={execution.account_env === 'demo' ? 'text-accent' : 'text-red'} />
        <StatCard label={instrumentLabel(execution.broker)} value={execution.token || '-'} colorClass="text-accent" />
        <StatCard label="LTP" value={latestTick ? latestTick.ltp.toFixed(2) : '-'} colorClass="text-accent" />
        <StatCard label="In position" value={execution.is_in_position ? 'Yes' : 'No'} />
      </div>

      {includeServerInfo ? (
        <ServerInfoPanel
          port={execution.data_plane_port}
          apiBaseUrl={execution.api_base_url || liveApi}
          wsUrl={execution.ws_url}
          logFile={execution.log_file}
          pending={!execution.log_file && !execution.data_plane_port}
        />
      ) : null}

      <StrategyParametersPanel execution={execution} onRefresh={onRefresh} />
    </div>
  )
}

export function OrderManagementTab({ globalView, liveApi, execution, executorId, realtimeEvents }) {
  const [orders, setOrders] = useState({})
  const [loading, setLoading] = useState(true)
  const filterExecutorId = !globalView ? (execution?.executor_id || executorId || null) : null

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams()
    if (filterExecutorId) params.set('executor_id', filterExecutorId)

    const loadPersisted = fetch(`${CONTROL_API}/orders?${params}`)
      .then(res => res.json())
      .then(data => (data.status ? (data.data || {}) : {}))
      .catch(() => ({}))

    const loadLive = !globalView && liveApi
      ? fetch(`${liveApi}/orders`)
          .then(res => res.json())
          .then(data => (data.status ? (data.data || {}) : {}))
          .catch(() => ({}))
      : Promise.resolve({})

    Promise.all([loadPersisted, loadLive]).then(([persisted, live]) => {
      if (cancelled) return
      const merged = { ...persisted, ...live }
      if (filterExecutorId) {
        setOrders(Object.fromEntries(
          Object.entries(merged).filter(([, order]) => order.executor_id === filterExecutorId),
        ))
        return
      }
      setOrders(merged)
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })

    return () => { cancelled = true }
  }, [globalView, liveApi, filterExecutorId, realtimeEvents.length])

  if (loading) {
    return (
      <EmptyState
        title="Loading orders"
        body={globalView ? 'Fetching all persisted orders.' : 'Fetching persisted and live order state.'}
      />
    )
  }

  const rows = Object.entries(orders)
    .filter(([, order]) => !filterExecutorId || order.executor_id === filterExecutorId)
    .map(([uid, order]) => [
      order.order_id || uid,
      order.unique_order_id || '-',
      order.symbol || order.executor_id || '-',
      order.order_type || '-',
      <StatusBadge status={(order.status || 'unknown').toUpperCase()} />,
    ])

  return (
    <div className="p-4">
      {globalView ? (
        <div className="mb-3 text-[10px] text-text-secondary">
          Showing all persisted orders across strategies.
        </div>
      ) : filterExecutorId ? (
        <div className="mb-3 text-[10px] text-text-secondary">
          Orders for execution <span className="font-mono text-accent">{filterExecutorId}</span>
        </div>
      ) : null}
      {rows.length ? (
        <DataTable columns={['Order ID', 'Unique ID', 'Strategy', 'Type', 'Status']} rows={rows} />
      ) : (
        <EmptyState title="No orders tracked" body="Orders will appear here as the trading manager places and updates them." />
      )}
    </div>
  )
}

export function TradingEventsTab({ globalView, liveApi, execution, executorId, realtimeEvents }) {
  const [dbEvents, setDbEvents] = useState([])
  const filterExecutorId = !globalView ? (execution?.executor_id || executorId || null) : null

  useEffect(() => {
    const params = new URLSearchParams({ limit: '100' })
    if (filterExecutorId) params.set('executor_id', filterExecutorId)

    fetch(`${CONTROL_API}/events?${params}`)
      .then(res => res.json())
      .then(data => { if (data.status) setDbEvents(data.data || []) })
      .catch(() => setDbEvents([]))
  }, [globalView, filterExecutorId, realtimeEvents.length])

  const liveEvents = globalView ? [] : realtimeEvents
  const seen = new Set()
  const events = [...liveEvents, ...dbEvents]
    .filter(event => {
      if (filterExecutorId) {
        const execId = event.executor_id || event.details?.executor_id
        if (execId !== filterExecutorId) return false
      }
      const key = `${event.id || ''}-${event.timestamp || event.created_at || ''}-${event.action}-${event.order_id || ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 150)

  return (
    <div className="p-4">
      {globalView ? (
        <div className="mb-3 text-[10px] text-text-secondary">
          Showing all persisted events across strategies. Open a strategy for live websocket updates.
        </div>
      ) : filterExecutorId ? (
        <div className="mb-3 text-[10px] text-text-secondary">
          Events for execution <span className="font-mono text-accent">{filterExecutorId}</span>
        </div>
      ) : null}
      <EventList events={events} emptyTitle="No trading events yet" />
    </div>
  )
}

function HistoricalEventsTab({ globalView, execution }) {
  const [sessions, setSessions] = useState([])
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [events, setEvents] = useState([])
  const [fallbackEvents, setFallbackEvents] = useState([])

  useEffect(() => {
    fetch(`${CONTROL_API}/event-sessions`)
      .then(res => res.json())
      .then(data => {
        const rows = (data.status ? (data.data || []) : [])
          .filter(session => globalView || !execution?.executor_id || session.id === execution.executor_id)
        setSessions(rows)
        setSelectedSessionId(
          !globalView && execution?.executor_id && rows.some(session => session.id === execution.executor_id)
            ? execution.executor_id
            : (rows[0]?.id || ''),
        )
      })
      .catch(() => {
        setSessions([])
        setSelectedSessionId(!globalView ? (execution?.executor_id || '') : '')
      })
  }, [globalView, execution?.executor_id])

  useEffect(() => {
    const params = new URLSearchParams({ limit: '100' })
    if (!globalView && execution?.executor_id) params.set('executor_id', execution.executor_id)

    fetch(`${CONTROL_API}/events?${params}`)
      .then(res => res.json())
      .then(data => { if (data.status) setFallbackEvents(data.data || []) })
      .catch(() => setFallbackEvents([]))
  }, [globalView, execution?.executor_id])

  useEffect(() => {
    if (!selectedSessionId) {
      setEvents([])
      return
    }
    fetch(`${CONTROL_API}/event-sessions/${encodeURIComponent(selectedSessionId)}/events?limit=300`)
      .then(res => res.json())
      .then(data => setEvents(data.data || data.events || []))
      .catch(() => setEvents([]))
  }, [selectedSessionId])

  if (!sessions.length) {
    return (
      <div className="p-4">
        <div className="mb-3 text-[10px] text-text-secondary">
          {globalView
            ? 'Persisted events from the control plane database across all executions.'
            : 'Persisted events for this execution from the control plane database.'}
        </div>
        <EventList events={fallbackEvents} emptyTitle="No historical events found" />
      </div>
    )
  }

  return (
    <div className="p-4 flex gap-4">
      <aside className="w-[280px] shrink-0 space-y-2">
        {globalView ? (
          <div className="mb-2 text-[10px] text-text-secondary">
            All execution sessions from the control plane database.
          </div>
        ) : null}
        {sessions.map(session => (
          <button
            key={session.id}
            onClick={() => setSelectedSessionId(session.id)}
            className={`w-full text-left p-3 rounded border ${
              selectedSessionId === session.id ? 'border-accent bg-accent/10' : 'border-border bg-card'
            }`}
          >
            <div className="text-[11px] font-bold truncate">{session.label || session.id}</div>
            <div className="text-[9px] text-text-secondary mt-1">{session.started_at}</div>
          </button>
        ))}
      </aside>
      <div className="flex-1">
        <EventList events={events} emptyTitle="No events for this session" />
      </div>
    </div>
  )
}

export function LaunchTab({ executions, selectedLaunchId, onSelect, onStarted, onStopped, onDuplicate, onRefresh, singleExecution = false, embedded = false }) {
  const selected = executions.find(item => item.execution_id === selectedLaunchId) || executions[0] || null
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState('')
  const [startInfo, setStartInfo] = useState(null)

  useEffect(() => {
    setStartInfo(null)
    setError('')
  }, [selectedLaunchId])

  const startExecution = async () => {
    if (!selected) return
    setStarting(true)
    setError('')
    setStartInfo(null)
    try {
      const { engine, executor, port, logFile, apiBaseUrl } = await startControlledExecution(selected.execution_id)
      setStartInfo({ port, logFile, apiBaseUrl, engineId: engine.id })
      await onRefresh()
      onStarted(engine, executor)
    } catch (err) {
      setError(err.message || 'Failed to start execution')
    } finally {
      setStarting(false)
    }
  }

  const stopExecution = async () => {
    if (!selected) return
    setStopping(true)
    setError('')
    try {
      const res = await fetch(`${CONTROL_API}/executions/${selected.execution_id}/stop`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        setError(data.detail || 'Failed to stop live server')
        return
      }
      setStartInfo(null)
      await onRefresh()
      await onStopped(selected.execution_id)
    } catch (err) {
      setError(err.message || 'Failed to stop execution')
    } finally {
      setStopping(false)
    }
  }

  if (!executions.length) {
    return (
      <EmptyState
        title="No executions queued"
        body="Create an execution first, then come back here to start its live server."
      />
    )
  }

  const engine = selected?.engine || {}
  const executor = selected?.executor || {}
  const status = String(engine.status || 'pending').toUpperCase()
  const canStart = ['PENDING', 'STOPPED', 'FAILED', 'STALE'].includes(status)
  const canStop = ['STARTING', 'RUNNING', 'STALE'].includes(status)
  const showSidebar = !singleExecution && executions.length > 1

  return (
    <div className={embedded ? '' : singleExecution ? 'border-b border-border px-4 py-4' : 'p-5 max-w-5xl'}>
      {!singleExecution && !embedded ? (
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-sm font-bold">Deploy Strategy</h2>
            <p className="text-[10px] text-text-secondary mt-1">
              Deploy when you are ready. You will get the runtime port and log file path.
            </p>
          </div>
          <button onClick={onRefresh} className="px-3 py-1.5 bg-card border border-border rounded text-[10px]">
            Refresh
          </button>
        </div>
      ) : null}

      <div className={showSidebar ? 'grid grid-cols-[280px_1fr] gap-4' : ''}>
        {showSidebar ? (
          <aside className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
            {executions.map(item => (
              <button
                key={item.execution_id}
                type="button"
                onClick={() => onSelect(item.execution_id)}
                className={`w-full rounded border p-3 text-left ${
                  selected?.execution_id === item.execution_id ? 'border-accent bg-accent/10' : 'border-border bg-card'
                }`}
              >
                <div className="truncate text-[11px] font-bold">{item.engine?.label || item.engine?.strategy_name || 'Strategy'}</div>
                <div className="mt-1 truncate font-mono text-[9px] text-accent">{item.execution_id}</div>
                <div className="mt-1 truncate text-[9px] text-text-secondary">{item.executor?.symbol || item.engine?.symbol || '—'}</div>
                {item.engine?.created_at ? (
                  <div className="mt-1 truncate text-[9px] text-text-secondary">
                    Created {formatDbTimestamp(item.engine.created_at)}
                  </div>
                ) : null}
                <div className="mt-2"><StatusBadge status={item.engine?.status || 'pending'} /></div>
              </button>
            ))}
          </aside>
        ) : null}

      <div className={embedded ? 'space-y-4' : singleExecution ? 'space-y-4' : 'bg-card border border-border rounded p-4 space-y-4'}>
        {singleExecution && !embedded ? (
          <h3 className="text-xs font-bold uppercase tracking-[1.5px]">Deploy</h3>
        ) : null}
        {!singleExecution && !embedded ? (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-bold truncate">{engine.label || engine.strategy_name || selected.execution_id}</div>
                <div className="text-[10px] font-mono text-accent mt-1 break-all">{selected.execution_id}</div>
                {engine.created_at ? (
                  <div className="text-[10px] text-text-secondary mt-1">
                    Created {formatDbTimestamp(engine.created_at)}
                  </div>
                ) : null}
                <div className="text-[10px] text-text-secondary mt-1">
                  Strategy: {engine.strategy_name || '—'} · {executor.symbol || engine.symbol} · {instrumentLabel(engine.broker)} {executor.token || engine.token}
                </div>
              </div>
              <StatusBadge status={engine.status || 'pending'} />
            </div>

            <div className="grid grid-cols-3 gap-3 text-xs">
              <StatCard label="Broker" value={engine.broker || '-'} />
              <StatCard label="Environment" value={envLabel(engine.account_env)} />
              <StatCard label="Strategy" value={engine.strategy_name || '-'} />
              <StatCard label="Close Price" value={executor.close_price ?? '-'} />
              <StatCard label="Take Profit" value={executor.long_percent != null ? `${executor.long_percent}%` : '-'} />
              <StatCard label="Stop Loss" value={executor.short_percent != null ? `${executor.short_percent}%` : '-'} />
            </div>
          </>
        ) : null}

        {!embedded ? (
          <ServerInfoPanel
            port={startInfo?.port || engine.port}
            apiBaseUrl={startInfo?.apiBaseUrl || engine.api_base_url}
            wsUrl={engine.ws_url}
            logFile={startInfo?.logFile || engine.metadata?.log_file}
            pending={status === 'PENDING' && !(startInfo?.logFile || engine.metadata?.log_file)}
            hideTitle={singleExecution}
          />
        ) : null}

          {error && <div className="text-xs text-red">{error}</div>}

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={startExecution}
              disabled={starting || stopping || !canStart}
              className="px-5 py-2 bg-green text-white rounded text-xs font-bold disabled:opacity-50"
            >
              {starting ? 'Deploying...' : status === 'RUNNING' ? 'Deployed' : 'Deploy'}
            </button>
            {!embedded ? (
              <>
                <button
                  onClick={stopExecution}
                  disabled={starting || stopping || !canStop}
                  className="px-5 py-2 bg-red text-white rounded text-xs font-bold disabled:opacity-50"
                >
                  {stopping ? 'Stopping...' : 'Stop'}
                </button>
                <button
                  onClick={() => onDuplicate(selected)}
                  disabled={starting || stopping}
                  className="px-5 py-2 bg-card border border-border rounded text-xs font-bold disabled:opacity-50"
                >
                  Duplicate
                </button>
              </>
            ) : null}
            {!canStart && status !== 'RUNNING' && !canStop && (
              <span className="text-[10px] text-text-secondary">Status: {status}</span>
            )}
          </div>
      </div>
      </div>
    </div>
  )
}

export function CreateExecutionPanel({ duplicateDraft, onCreated, onStarted, onCancel }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [selectedStock, setSelectedStock] = useState(null)
  const [closePriceManual, setClosePriceManual] = useState(false)
  const [form, setForm] = useState({
    broker: 'angel',
    account_env: 'live',
    strategy_name: 'one-percent',
    executor_id: '',
    close_price: '',
    long_percent: '1.0',
    short_percent: '10.0',
    initial_threshold: '0.2',
    max_available_capital: '100000',
    allow_partial_stocks: false,
    use_fake_client: false,
    client_mode: 'standard',
    feed_mode: 'websocket',
    tick_sample_every: '1',
  })
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [startingLive, setStartingLive] = useState(false)
  const [showStartConfirm, setShowStartConfirm] = useState(false)
  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  const [scheduledDate, setScheduledDate] = useState('')
  const [scheduleHint, setScheduleHint] = useState('')
  const [tradingDayOptions, setTradingDayOptions] = useState([])
  const [scheduleOptionsLoading, setScheduleOptionsLoading] = useState(false)
  const { ltp, marketError, streamStatus: marketStreamStatus } = useMarketPreview({
    broker: form.broker,
    token: selectedStock?.symboltoken,
    symbol: selectedStock?.tradingsymbol,
    exchange: selectedStock?.exchange || 'NSE',
    account_env: form.account_env,
    use_fake_client: form.use_fake_client,
    feed_mode: form.feed_mode,
    enabled: Boolean(selectedStock?.symboltoken),
  })

  const levels = useMemo(
    () => computeExecutionLevels(form),
    [form.close_price, form.initial_threshold, form.long_percent, form.short_percent, form.max_available_capital, form.allow_partial_stocks],
  )

  const fallbackTradingDayOptions = useMemo(
    () => buildLocalTradingDayOptions(form.broker).options,
    [form.broker],
  )

  const visibleTradingDayOptions = tradingDayOptions.length
    ? tradingDayOptions
    : fallbackTradingDayOptions

  useEffect(() => {
    let cancelled = false
    setScheduleOptionsLoading(true)
    ;(async () => {
      const options = await loadTradingDayOptions(form.broker, form.use_fake_client)
      if (cancelled) return
      setTradingDayOptions(options.options)
      setScheduleHint(options.market_open_label)
      setScheduleOptionsLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [form.broker, form.use_fake_client])

  useEffect(() => {
    if (!scheduleEnabled || !visibleTradingDayOptions.length) return
    setScheduledDate(prev => {
      if (prev && visibleTradingDayOptions.some(option => option.trading_day === prev)) return prev
      return visibleTradingDayOptions[0].trading_day
    })
  }, [scheduleEnabled, visibleTradingDayOptions])

  useEffect(() => {
    if (!duplicateDraft?.template) return
    const template = duplicateDraft.template
    const executor = duplicateDraft.executor || {}
    setForm({
      broker: template.broker || 'angel',
      account_env: template.account_env || 'live',
      strategy_name: template.strategy_name || 'one-percent',
      executor_id: template.executor_id || '',
      close_price: String(template.close_price ?? executor.close_price ?? ''),
      long_percent: String(template.long_percent ?? executor.long_percent ?? '1.0'),
      short_percent: String(template.short_percent ?? executor.short_percent ?? '10.0'),
      initial_threshold: String(template.initial_threshold ?? executor.initial_threshold ?? '0.2'),
      max_available_capital: String(template.max_available_capital ?? executor.max_available_capital ?? '100000'),
      allow_partial_stocks: Boolean(template.allow_partial_stocks ?? executor.allow_partial_stocks),
      use_fake_client: Boolean(template.use_fake_client),
      client_mode: template.client_mode || 'standard',
      feed_mode: template.feed_mode || 'websocket',
      tick_sample_every: String(template.tick_sample_every ?? executor.tick_sample_every ?? '1'),
    })
    setScheduledDate(template.scheduled_date || template.trading_day || '')
    setScheduleHint(template.market_open_label || '')
    setScheduleEnabled(Boolean(
      template.schedule_enabled
      || template.scheduled_date
      || template.trading_day,
    ))
    setSelectedStock({
      tradingsymbol: template.symbol || executor.symbol,
      symboltoken: template.token || executor.token,
      exchange: template.exchange || executor.exchange || 'NSE',
    })
    setClosePriceManual(Boolean(template.close_price ?? executor.close_price))
    setResults([])
    setQuery('')
    setError('')
  }, [duplicateDraft])

  useEffect(() => {
    if (ltp == null || closePriceManual || !selectedStock) return
    setForm(prev => ({ ...prev, close_price: formatPriceInput(ltp) }))
  }, [ltp, closePriceManual, selectedStock])

  const search = async () => {
    if (!query.trim()) return
    setError('')
    const params = new URLSearchParams({
      q: query.trim(),
      broker: form.broker,
      account_env: form.account_env,
      exchange: form.broker === 'etoro' ? 'ETORO' : 'NSE',
      use_fake_client: String(form.use_fake_client),
    })
    const url = `${CONTROL_API}/search?${params.toString()}`
    console.info('[CreateExecution] Searching instruments', Object.fromEntries(params.entries()))
    try {
      const res = await fetch(url)
      const data = await res.json().catch(() => null)
      console.info('[CreateExecution] Search response', { ok: res.ok, status: res.status, data })
      if (!res.ok || !data?.status) {
        const message = data?.message || data?.detail || `Search failed with HTTP ${res.status}`
        setError(message)
        setResults([])
        return
      }
      setResults(data.data || [])
      if (!(data.data || []).length) {
        let hint = ''
        if (form.use_fake_client) {
          hint = ' Fake client only includes a small mock symbol list (e.g. BTC, ETH, AAPL, TSLA, INFY-EQ).'
        } else if (form.broker === 'etoro') {
          hint = ' Check eToro credentials and that the selected environment (Demo/Live) is configured.'
        } else if (/btc|eth|crypto|usd|eur/i.test(query.trim()) && form.broker === 'angel') {
          hint = ' Angel search only covers NSE/BSE symbols — switch Broker to eToro for crypto and global instruments.'
        }
        setError(`No results found for "${query.trim()}".${hint}`)
      }
    } catch (err) {
      console.error('[CreateExecution] Search request failed', err)
      setError(err.message || 'Search request failed')
      setResults([])
    }
  }

  const selectStock = stock => {
    setSelectedStock(stock)
    setClosePriceManual(false)
    setShowStartConfirm(false)
    const nextId = buildExecutionId(form.broker, stock.tradingsymbol, form.strategy_name)
    setForm(prev => ({
      ...prev,
      executor_id: nextId,
      close_price: '',
      allow_partial_stocks: prev.broker === 'etoro' ? true : prev.allow_partial_stocks,
    }))
    setResults([])
    setQuery('')
  }

  const buildExecutionPayload = ({ startImmediately = false } = {}) => ({
    source_id: EXECUTION_SOURCE_USER,
    executor_id: form.executor_id,
    broker: form.broker,
    account_env: form.account_env,
    strategy_name: form.strategy_name,
    symbol: selectedStock.tradingsymbol,
    token: selectedStock.symboltoken,
    exchange: selectedStock.exchange || 'NSE',
    close_price: Number(form.close_price),
    long_percent: Number(form.long_percent),
    short_percent: Number(form.short_percent),
    initial_threshold: Number(form.initial_threshold),
    max_available_capital: Number(form.max_available_capital),
    allow_partial_stocks: Boolean(form.allow_partial_stocks),
    use_fake_client: form.use_fake_client,
    client_mode: form.broker === 'etoro' ? form.client_mode : 'standard',
    feed_mode: form.broker === 'angel' ? form.feed_mode : 'websocket',
    tick_sample_every: Math.max(1, Math.min(300, parseInt(form.tick_sample_every, 10) || 1)),
    schedule_enabled: !startImmediately && scheduleEnabled,
    scheduled_date: !startImmediately && scheduleEnabled ? (scheduledDate || null) : null,
    start_immediately: startImmediately,
  })

  const validateForm = () => {
    if (!selectedStock) {
      setError('Select a stock first')
      return false
    }
    if (!Number(form.close_price)) {
      setError('Close price is required')
      return false
    }
    if (scheduleEnabled && !scheduledDate) {
      setError('Select a trading day for the scheduled start')
      return false
    }
    return true
  }

  const saveExecution = async ({ startImmediately = false } = {}) => {
    const res = await fetch(`${CONTROL_API}/executions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildExecutionPayload({ startImmediately })),
    })
    const data = await res.json()
    if (!res.ok) {
      throw new Error(data.detail || 'Failed to create execution')
    }
    return data.data.execution_id
  }

  const submit = async () => {
    if (!validateForm()) return

    setSubmitting(true)
    setError('')
    try {
      const executionId = await saveExecution()
      onCreated(executionId)
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const startLiveTrading = async () => {
    if (!validateForm()) return

    setStartingLive(true)
    setError('')
    try {
      const executionId = await saveExecution({ startImmediately: true })
      const { engine, executor } = await startControlledExecution(executionId)
      onCreated(executionId)
      await onStarted(engine, executor)
    } catch (err) {
      setError(err.message || 'Failed to start live trading')
    } finally {
      setStartingLive(false)
      setShowStartConfirm(false)
    }
  }

  const strategyLabel = selectedStock?.tradingsymbol || form.executor_id || 'this strategy'
  const actionBusy = submitting || startingLive

  return (
    <div className="p-5 max-w-6xl">
      <CountdownConfirmOverlay
        open={showStartConfirm}
        seconds={10}
        title="Start Live Trading"
        body={`${strategyLabel} will be saved and live trading will begin when the countdown reaches zero.`}
        confirmLabel="Saving strategy and starting live server..."
        onCancel={() => setShowStartConfirm(false)}
        onComplete={startLiveTrading}
      />

      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-sm font-bold">{duplicateDraft ? 'Duplicate Execution' : 'Create Execution'}</h2>
          <p className="text-[10px] text-text-secondary mt-1">
            {duplicateDraft
              ? 'Edit the copied config, then save as a new draft or scheduled execution.'
              : 'Search a stock, confirm live close price and levels, then save the strategy.'}
          </p>
        </div>
        <button onClick={onCancel} className="text-xs text-text-secondary hover:text-text-primary">Cancel</button>
      </div>

      <div className="mb-5">
        <StrategyScheduleSection
          scheduleEnabled={scheduleEnabled}
          onScheduleEnabledChange={checked => {
            setScheduleEnabled(checked)
            if (!checked) setError('')
          }}
          scheduledDate={scheduledDate}
          onScheduledDateChange={setScheduledDate}
          tradingDayOptions={visibleTradingDayOptions}
          scheduleHint={scheduleHint}
          loading={scheduleOptionsLoading}
          broker={form.broker}
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_0.8fr] gap-5">
        <div className="grid grid-cols-2 gap-4 content-start">
          <div>
            <label className="text-[9px] uppercase tracking-[1.5px] text-text-secondary block mb-1">Broker</label>
            <select
              value={form.broker}
              onChange={e => {
                const value = e.target.value
                setSelectedStock(null)
                setResults([])
                setForm(prev => ({
                  ...prev,
                  broker: value,
                  allow_partial_stocks: value === 'etoro' ? true : prev.allow_partial_stocks,
                }))
              }}
              className="w-full px-3 py-2 bg-card border border-border rounded text-xs text-text-primary outline-none focus:border-accent"
            >
              {BROKER_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[9px] uppercase tracking-[1.5px] text-text-secondary block mb-1">Environment</label>
            <select
              value={form.account_env}
              onChange={e => setForm(prev => ({ ...prev, account_env: e.target.value }))}
              className="w-full px-3 py-2 bg-card border border-border rounded text-xs text-text-primary outline-none focus:border-accent"
            >
              <option value="live">LIVE</option>
              <option value="demo">DEMO</option>
            </select>
          </div>

          <FormField label="Strategy Name" value={form.strategy_name} onChange={value => setForm(prev => ({ ...prev, strategy_name: value }))} />
          <div>
            <label className="text-[9px] uppercase tracking-[1.5px] text-text-secondary block mb-1">Client Mode</label>
            <select
              value={form.client_mode}
              onChange={e => setForm(prev => ({ ...prev, client_mode: e.target.value }))}
              disabled={form.broker !== 'etoro'}
              className="w-full px-3 py-2 bg-card border border-border rounded text-xs text-text-primary outline-none focus:border-accent disabled:opacity-50"
            >
              <option value="standard">Standard (feed TP/SL)</option>
              <option value="bracket">Bracket Order</option>
            </select>
          </div>
          {form.broker === 'angel' && !form.use_fake_client ? (
            <div>
              <label className="text-[9px] uppercase tracking-[1.5px] text-text-secondary block mb-1">Price Feed</label>
              <select
                value={form.feed_mode}
                onChange={e => setForm(prev => ({ ...prev, feed_mode: e.target.value }))}
                className="w-full px-3 py-2 bg-card border border-border rounded text-xs text-text-primary outline-none focus:border-accent"
              >
                {ANGEL_FEED_OPTIONS.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          ) : null}
          <div>
            <FormField
              label="Tick sampling (every N ticks)"
              type="number"
              value={form.tick_sample_every}
              onChange={value => setForm(prev => ({ ...prev, tick_sample_every: value }))}
            />
            <p className="mt-1 text-[10px] text-text-secondary">
              Strategy runs on every Nth price tick (~1 tick/sec on WebSocket). N=5 ≈ one check every 5s.
            </p>
          </div>
          <div className="col-span-2">
            <FormField label="Execution ID" value={form.executor_id} onChange={value => setForm(prev => ({ ...prev, executor_id: value }))} />
          </div>

          <div className="col-span-2">
            <label className="text-[9px] uppercase tracking-[1.5px] text-text-secondary block mb-1">Stock</label>
            <div className="flex gap-2">
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && search()}
                placeholder="Search stock"
                className="flex-1 px-3 py-2 bg-card border border-border rounded text-xs text-text-primary outline-none focus:border-accent placeholder:text-text-secondary"
              />
              <button onClick={search} className="px-4 py-2 bg-accent text-white rounded text-xs font-bold">Search</button>
            </div>
            {selectedStock && (
              <p className="mt-2 text-xs text-green">
                Selected: {selectedStock.tradingsymbol} · {instrumentLabel(form.broker)} {selectedStock.symboltoken}
              </p>
            )}
            {!!results.length && (
              <div className="mt-2 border border-border rounded bg-card max-h-40 overflow-auto">
                {results.slice(0, 20).map(stock => (
                  <button key={stock.symboltoken} onClick={() => selectStock(stock)} className="w-full text-left px-3 py-2 text-xs hover:bg-accent/10 border-b border-border/40">
                    {stock.tradingsymbol} <span className="text-text-secondary">· {stock.exchange} · {instrumentLabel(form.broker)} {stock.symboltoken}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <FormField label="Initial Threshold %" type="number" value={form.initial_threshold} onChange={value => setForm(prev => ({ ...prev, initial_threshold: value }))} />
          <FormField label="Capital" type="number" value={form.max_available_capital} onChange={value => setForm(prev => ({ ...prev, max_available_capital: value }))} />
          <FormField label="Take Profit %" type="number" value={form.long_percent} onChange={value => setForm(prev => ({ ...prev, long_percent: value }))} />
          <FormField label="Stop Loss %" type="number" value={form.short_percent} onChange={value => setForm(prev => ({ ...prev, short_percent: value }))} />
          <label className="col-span-2 flex items-center gap-2 text-xs text-text-secondary">
            <input
              type="checkbox"
              checked={form.allow_partial_stocks}
              onChange={e => setForm(prev => ({ ...prev, allow_partial_stocks: e.target.checked }))}
            />
            Allow partial stocks (quantity rounded to 2 decimals)
          </label>
          <label className="col-span-2 flex items-center gap-2 text-xs text-text-secondary">
            <input
              type="checkbox"
              checked={form.use_fake_client}
              onChange={e => setForm(prev => ({ ...prev, use_fake_client: e.target.checked }))}
            />
            Use fake broker client
          </label>
        </div>

        <MarketPreviewPanel
          selectedStock={selectedStock}
          ltp={ltp}
          streamStatus={marketStreamStatus}
          marketError={marketError}
          closePrice={form.close_price}
          onClosePriceChange={value => {
            setClosePriceManual(true)
            setForm(prev => ({ ...prev, close_price: value }))
          }}
          onUseLivePrice={() => {
            setClosePriceManual(false)
            if (ltp != null) setForm(prev => ({ ...prev, close_price: formatPrice(ltp) }))
          }}
          levels={levels}
          form={form}
        />
      </div>

      {error && <div className="mt-4 text-xs text-red">{error}</div>}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          onClick={submit}
          disabled={actionBusy || !selectedStock || showStartConfirm}
          className="px-5 py-2 bg-green text-white rounded text-xs font-bold disabled:opacity-50"
        >
          {submitting ? 'Saving...' : duplicateDraft ? 'Save Duplicate' : 'Save Strategy'}
        </button>
        <button
          onClick={() => {
            if (!validateForm()) return
            setError('')
            setShowStartConfirm(true)
          }}
          disabled={actionBusy || !selectedStock || showStartConfirm}
          className="px-5 py-2 bg-accent text-white rounded text-xs font-bold disabled:opacity-50"
        >
          {startingLive ? 'Starting live trading...' : 'Start Live Trading'}
        </button>
      </div>
    </div>
  )
}

function formatEventTime(event) {
  if (event.created_at) return String(event.created_at)
  if (event.received_at) return String(event.received_at)
  const ts = Number(event.timestamp || event.started_at || event.last_at)
  if (Number.isFinite(ts) && ts > 1_000_000_000) {
    return new Date(ts * 1000).toLocaleString()
  }
  return new Date().toLocaleTimeString()
}

function EventList({ events, emptyTitle }) {
  if (!events.length) return <EmptyState title={emptyTitle} body="Realtime and persisted events will appear here." />
  return (
    <div className="space-y-1">
      {events.map((event, index) => {
        const action = getEventAction(event)
        const details = event.details || event.content || event.raw_json || event.raw || {}
        const when = formatEventTime(event)
        return (
          <div key={`${action}-${index}`} className="px-3 py-2 bg-card border border-border/50 rounded text-xs flex items-center gap-3">
            <span className="w-36 shrink-0 text-[9px] text-text-secondary font-mono">
              {when}
            </span>
            <span className={`w-40 shrink-0 text-[10px] font-bold ${eventColor(action)}`}>{action}</span>
            <span className="truncate text-text-secondary">
              {event.order_id || event.broker_order_id ? `order=${event.order_id || event.broker_order_id} ` : ''}
              {event.position_id || event.broker_position_id ? `position=${event.position_id || event.broker_position_id} ` : ''}
              {event.executor_id || details.executor_id ? `execution=${event.executor_id || details.executor_id} ` : ''}
              {event.symbol || details.symbol || ''}
              {event.instrument_token || details.instrument_token || details.instrumentID || details.instrumentId
                ? ` · instrument=${event.instrument_token || details.instrument_token || details.instrumentID || details.instrumentId}`
                : ''}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function ExecutionLevels({ execution }) {
  const levels = computeExecutionLevels(execution)
  const broker = execution?.broker

  return (
    <div className="grid grid-cols-4 gap-3">
      <StatCard label="Previous Close" value={levels.closePrice != null ? formatBrokerPrice(broker, levels.closePrice) : '-'} />
      <StatCard label="Buy Trigger" value={levels.buyTrigger != null ? formatBrokerPrice(broker, levels.buyTrigger) : '-'} colorClass="text-accent" />
      <StatCard label="Take Profit" value={levels.takeProfit != null ? formatBrokerPrice(broker, levels.takeProfit) : '-'} colorClass="text-green" />
      <StatCard label="Stop Loss" value={levels.stopLoss != null ? formatBrokerPrice(broker, levels.stopLoss) : '-'} colorClass="text-red" />
    </div>
  )
}

function MarketPreviewPanel({
  selectedStock,
  ltp,
  streamStatus,
  marketError,
  closePrice,
  onClosePriceChange,
  onUseLivePrice,
  levels,
  form,
}) {
  if (!selectedStock) {
    return (
      <div className="bg-card border border-border rounded-lg p-6 min-h-[420px] flex items-center justify-center text-center">
        <div>
          <div className="text-sm font-bold text-text-primary mb-2">Live Market Preview</div>
          <p className="text-xs text-text-secondary max-w-xs">
            Search and select a stock to stream the current price over websocket and preview buy trigger, take profit, and stop loss levels.
          </p>
        </div>
      </div>
    )
  }

  const displayLtp = ltp != null ? formatBrokerPrice(form.broker, ltp) : '--'
  const livePrice = ltp != null ? Number(ltp) : null
  const closeNum = Number(closePrice)
  const priceDelta = livePrice != null && Number.isFinite(closeNum) && closeNum > 0
    ? ((livePrice - closeNum) / closeNum) * 100
    : null

  return (
    <div className="bg-card border border-border rounded-lg p-5 min-h-[420px] flex flex-col">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <div className="text-[10px] uppercase tracking-[2px] text-text-secondary">Live Price</div>
          <div className="text-2xl font-bold text-text-primary mt-1">{selectedStock.tradingsymbol}</div>
          <div className="text-[10px] text-text-secondary mt-1">
            {selectedStock.exchange} · {instrumentLabel(form.broker)} {selectedStock.symboltoken}
          </div>
        </div>
        <div className={`text-[10px] px-2 py-1 rounded ${
          streamStatus.tone === 'ok'
            ? 'bg-green/15 text-green'
            : streamStatus.tone === 'error'
              ? 'bg-red/15 text-red'
              : streamStatus.tone === 'warn'
                ? 'bg-yellow-400/15 text-yellow-400'
                : 'bg-secondary text-text-secondary'
        }`}>
          {streamStatus.label}
        </div>
      </div>

      <div className="rounded-lg bg-secondary/60 border border-border px-4 py-5 mb-4">
        <div className="text-[10px] uppercase tracking-[2px] text-text-secondary mb-2">Current Price</div>
        <div className="text-5xl font-bold tracking-tight text-accent">{displayLtp}</div>
        {priceDelta != null && (
          <div className={`text-xs mt-2 ${priceDelta >= 0 ? 'text-green' : 'text-red'}`}>
            {priceDelta >= 0 ? '+' : ''}{priceDelta.toFixed(3)}% vs close
          </div>
        )}
      </div>

      <div className="mb-4">
        <label className="text-[9px] uppercase tracking-[1.5px] text-text-secondary block mb-1">Close Price</label>
        <div className="flex gap-2">
          <input
            type="number"
            step="0.01"
            value={closePrice}
            onChange={e => onClosePriceChange(e.target.value)}
            className="flex-1 px-3 py-2.5 bg-card border border-border rounded text-sm font-semibold font-mono text-text-primary outline-none focus:border-accent [color-scheme:dark]"
          />
          <button
            type="button"
            onClick={onUseLivePrice}
            disabled={ltp == null}
            className="px-3 py-2 bg-accent/15 text-accent rounded text-[10px] font-bold disabled:opacity-40"
          >
            Use Live
          </button>
        </div>
        <p className="text-[10px] text-text-secondary mt-1">Defaults to the live websocket price. Edit to override.</p>
      </div>

      <div className="grid grid-cols-1 gap-2 mt-auto">
        <PreviewLevelRow label="Buy Trigger" value={formatBrokerPrice(form.broker, levels.buyTrigger)} hint={`+${form.initial_threshold}% from close`} tone="accent" />
        <PreviewLevelRow label="Take Profit" value={formatBrokerPrice(form.broker, levels.takeProfit)} hint={`+${form.long_percent}% from trigger`} tone="green" />
        <PreviewLevelRow label="Stop Loss" value={formatBrokerPrice(form.broker, levels.stopLoss)} hint={`-${form.short_percent}% from trigger`} tone="red" />
        <PreviewLevelRow
          label="Order Qty"
          value={levels.orderQuantity != null ? levels.orderQuantity.toFixed(form.allow_partial_stocks ? 2 : 0) : '--'}
          hint={form.allow_partial_stocks ? 'Partial units · 2 dp' : 'Whole shares only'}
          tone="default"
        />
      </div>

      {marketError && <div className="mt-3 text-[10px] text-red">{marketError}</div>}
    </div>
  )
}

function PreviewLevelRow({ label, value, hint, tone }) {
  const toneClass = tone === 'green' ? 'text-green' : tone === 'red' ? 'text-red' : 'text-accent'
  return (
    <div className="flex items-center justify-between px-3 py-2 rounded border border-border/60 bg-background/40">
      <div>
        <div className="text-[9px] uppercase tracking-[1.5px] text-text-secondary">{label}</div>
        <div className="text-[10px] text-text-secondary">{hint}</div>
      </div>
      <div className={`text-lg font-bold ${toneClass}`}>{value ?? '-'}</div>
    </div>
  )
}

function CountdownConfirmOverlay({
  open,
  seconds,
  title,
  body,
  confirmLabel = 'Confirming...',
  skipLabel = 'Looks good',
  onCancel,
  onComplete,
}) {
  const [remaining, setRemaining] = useState(seconds)
  const completedRef = useRef(false)
  const intervalRef = useRef(null)
  const onCompleteRef = useRef(onComplete)

  useEffect(() => {
    onCompleteRef.current = onComplete
  }, [onComplete])

  const finishNow = useCallback(() => {
    if (completedRef.current) return
    completedRef.current = true
    if (intervalRef.current != null) {
      window.clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    setRemaining(0)
    onCompleteRef.current()
  }, [])

  useEffect(() => {
    if (!open) {
      setRemaining(seconds)
      completedRef.current = false
      if (intervalRef.current != null) {
        window.clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      return undefined
    }

    setRemaining(seconds)
    completedRef.current = false
    intervalRef.current = window.setInterval(() => {
      setRemaining(prev => {
        if (prev <= 1) {
          if (intervalRef.current != null) {
            window.clearInterval(intervalRef.current)
            intervalRef.current = null
          }
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => {
      if (intervalRef.current != null) {
        window.clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [open, seconds])

  useEffect(() => {
    if (!open || remaining > 0 || completedRef.current) return
    completedRef.current = true
    window.queueMicrotask(() => onCompleteRef.current())
  }, [open, remaining])

  if (!open) return null

  const finishing = remaining === 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-2xl">
        <div className="text-sm font-bold text-text-primary">{title}</div>
        <p className="mt-2 text-xs text-text-secondary leading-relaxed">{body}</p>

        <div className="my-6 flex flex-col items-center">
          <div className="text-[10px] uppercase tracking-[2px] text-text-secondary mb-2">Starting in</div>
          <div className="text-6xl font-bold text-accent tabular-nums">{remaining}</div>
          <div className="text-[10px] text-text-secondary mt-2">{confirmLabel}</div>
        </div>

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={finishing}
            className="px-4 py-2 rounded border border-border bg-background text-xs font-bold text-text-primary disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={finishNow}
            disabled={finishing}
            className="px-4 py-2 rounded bg-green text-xs font-bold text-white disabled:opacity-50"
          >
            {skipLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function useMarketPreview({ broker, token, symbol, exchange, account_env, use_fake_client, feed_mode, enabled }) {
  const [ltp, setLtp] = useState(null)
  const [connected, setConnected] = useState(false)
  const [connectedAt, setConnectedAt] = useState(null)
  const [lastTickAt, setLastTickAt] = useState(null)
  const [marketError, setMarketError] = useState('')
  const socketRef = useRef(null)
  const nowMs = useNow(enabled ? PRICE_STREAM_STATUS_POLL_MS : null)

  const streamStatus = useMemo(() => {
    if (!enabled || !token || !symbol) {
      return { status: 'idle', label: 'Select a stock to preview', tone: 'muted' }
    }
    if (marketError) {
      return { status: 'error', label: marketError, tone: 'error' }
    }
    if (!connected) {
      return { status: 'connecting', label: 'Connecting to market feed…', tone: 'warn' }
    }
    if (!lastTickAt) {
      const connectedForMs = connectedAt ? nowMs - connectedAt : 0
      if (connectedForMs >= PRICE_STREAM_FIRST_TICK_MS) {
        return { status: 'no_ticks', label: 'Connected — no prices received', tone: 'error' }
      }
      return { status: 'waiting', label: 'Waiting for first tick…', tone: 'warn' }
    }
    const ageMs = nowMs - lastTickAt
    const ageSec = Math.max(0, Math.round(ageMs / 1000))
    if (ageMs > PRICE_STREAM_STALE_MS) {
      return { status: 'stale', label: `Prices stale (${ageSec}s ago)`, tone: 'error' }
    }
    return { status: 'flowing', label: 'Live prices flowing', tone: 'ok' }
  }, [enabled, token, symbol, marketError, connected, connectedAt, lastTickAt, nowMs])

  useEffect(() => {
    console.info(
      '[MarketPreview] status=%s label=%s symbol=%s connected=%s lastTickAge=%s',
      streamStatus.status,
      streamStatus.label,
      symbol || '-',
      connected,
      lastTickAt ? Math.round((nowMs - lastTickAt) / 1000) : 'none',
    )
  }, [streamStatus.status, streamStatus.label, symbol, connected, lastTickAt, nowMs])

  useEffect(() => {
    if (!enabled || !token || !symbol) {
      setLtp(null)
      setConnected(false)
      setConnectedAt(null)
      setLastTickAt(null)
      setMarketError('')
      if (socketRef.current) {
        socketRef.current.close()
        socketRef.current = null
      }
      return undefined
    }

    setLtp(null)
    setConnected(false)
    setConnectedAt(null)
    setLastTickAt(null)
    setMarketError('')

    const ws = new WebSocket(CONTROL_MARKET_WS)
    socketRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      setConnectedAt(Date.now())
      console.info('[MarketPreview] ws_open symbol=%s token=%s', symbol, token)
      ws.send(JSON.stringify({
        type: 'subscribe',
        broker,
        token: String(token),
        symbol,
        exchange: exchange || 'NSE',
        account_env,
        use_fake_client,
        feed_mode: broker === 'angel' ? feed_mode || 'websocket' : 'websocket',
      }))
    }

    ws.onmessage = event => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'tick' && msg.ltp != null) {
          const nextLtp = Number(msg.ltp)
          if (!Number.isFinite(nextLtp) || nextLtp <= 0) return
          setLtp(nextLtp)
          setLastTickAt(Date.now())
          setMarketError('')
        } else if (msg.type === 'error') {
          setMarketError(msg.message || 'Market preview failed')
        }
      } catch {
        setMarketError('Invalid market preview message')
      }
    }

    ws.onerror = () => setMarketError('Market websocket connection failed')
    ws.onclose = () => {
      setConnected(false)
      setConnectedAt(null)
      console.warn('[MarketPreview] ws_close symbol=%s token=%s', symbol, token)
      if (socketRef.current === ws) socketRef.current = null
    }

    return () => {
      ws.close()
      if (socketRef.current === ws) socketRef.current = null
    }
  }, [broker, token, symbol, exchange, account_env, use_fake_client, feed_mode, enabled])

  return { ltp, connected, marketError, streamStatus }
}

export function computeExecutionLevels(source) {
  const closePrice = Number(source.close_price || 0)
  if (!closePrice) {
    return { closePrice: null, buyTrigger: null, takeProfit: null, stopLoss: null, orderQuantity: null }
  }

  const buyTrigger = closePrice * (1 + Number(source.initial_threshold || 0) / 100)
  const takeProfit = buyTrigger * (1 + Number(source.long_percent || 0) / 100)
  const stopLoss = buyTrigger * (1 - Number(source.short_percent || 0) / 100)
  const orderQuantity = computeOrderQuantity(
    Number(source.max_available_capital || 0),
    buyTrigger,
    Boolean(source.allow_partial_stocks),
  )

  return {
    closePrice,
    buyTrigger,
    takeProfit,
    stopLoss,
    orderQuantity,
  }
}

export function computeOrderQuantity(capital, price, allowPartial = false) {
  if (!capital || !price || price <= 0) return null
  const raw = capital / price
  if (allowPartial) return Math.round(raw * 100) / 100
  return Math.floor(raw)
}

function formatPrice(value) {
  return formatPriceInput(value)
}

function DataTable({ columns, rows }) {
  return (
    <table className="w-full text-xs border border-border rounded overflow-hidden">
      <thead className="bg-secondary">
        <tr className="text-text-secondary border-b border-border">
          {columns.map(column => <th key={column} className="text-left py-2 px-3">{column}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex} className="border-b border-border/40 hover:bg-card">
            {row.map((cell, cellIndex) => <td key={cellIndex} className="py-2 px-3">{cell}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function FormField({ label, value, onChange, type = 'text' }) {
  return (
    <div>
      <label className="text-[9px] uppercase tracking-[1.5px] text-text-secondary block mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full px-3 py-2 bg-card border border-border rounded text-xs text-text-primary outline-none focus:border-accent [color-scheme:dark]"
      />
    </div>
  )
}

function StatCard({ label, value, colorClass = '' }) {
  return (
    <div className="bg-card border border-border rounded-md px-3 py-2">
      <div className="text-[8px] uppercase tracking-widest text-text-secondary mb-0.5">{label}</div>
      <div className={`text-[15px] font-bold ${colorClass}`}>{value}</div>
    </div>
  )
}

function Metric({ label, value }) {
  return (
    <div>
      <div className="text-[8px] uppercase">{label}</div>
      <div className="text-text-primary font-bold">{value ?? '-'}</div>
    </div>
  )
}

function StatusBadge({ status }) {
  const normalized = String(status || 'UNKNOWN').toUpperCase()
  const color = normalized.includes('RUN') || normalized.includes('ACTIVE')
    ? 'bg-green/20 text-green'
    : normalized.includes('STOP') || normalized.includes('FAIL')
      ? 'bg-red/20 text-red'
      : normalized.includes('POSITION')
        ? 'bg-accent/20 text-accent'
        : 'bg-card text-text-secondary'
  return <span className={`px-2 py-0.5 rounded text-[8px] font-bold ${color}`}>{normalized}</span>
}

function EnvBadge({ env }) {
  const normalized = envLabel(env)
  const color = normalized === 'DEMO'
    ? 'bg-accent/20 text-accent'
    : 'bg-red/20 text-red'
  return <span className={`px-2 py-1 rounded text-[9px] font-bold ${color}`}>{normalized}</span>
}

export function EmptyState({ title, body, action }) {
  return (
    <div className="p-8 text-center">
      <h3 className="text-sm font-bold mb-2">{title}</h3>
      <p className="text-xs text-text-secondary mb-4">{body}</p>
      {action}
    </div>
  )
}

function envLabel(env) {
  return String(env || 'live').toLowerCase() === 'demo' ? 'DEMO' : 'LIVE'
}

function instrumentLabel(broker) {
  return String(broker || '').toLowerCase() === 'etoro' ? 'Instrument ID' : 'Token'
}

async function ensureExecutorRegistered(runningEngine, executor) {
  if (!runningEngine?.api_base_url) {
    throw new Error('Live engine API URL is missing')
  }
  if (!executor?.executor_id) {
    throw new Error('Executor payload is missing')
  }

  const listRes = await fetch(`${runningEngine.api_base_url}/executors`)
  if (listRes.ok) {
    const listData = await listRes.json()
    const alreadyRegistered = (listData.data || []).some(
      row => row.executor_id === executor.executor_id,
    )
    if (alreadyRegistered) {
      return listData.data.find(row => row.executor_id === executor.executor_id)
    }
  }

  const executorRes = await fetch(`${runningEngine.api_base_url}/executors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(executor),
  })
  const executorData = await executorRes.json()
  if (!executorRes.ok) {
    throw new Error(executorData.detail || 'Live server started, but executor registration failed')
  }
  return executorData.data
}

export async function startControlledExecution(executionId) {
  const res = await fetch(`${CONTROL_API}/executions/${executionId}/start`, { method: 'POST' })
  const data = await res.json()
  if (!res.ok) {
    throw new Error(data.detail || 'Failed to start live server')
  }

  const { engine, executor, port, log_file: logFile, api_base_url: apiBaseUrl } = data.data
  const runningEngine = await waitForEngine(engine.id)
  await ensureExecutorRegistered(runningEngine, executor)

  return {
    engine: runningEngine,
    executor,
    port,
    logFile,
    apiBaseUrl,
  }
}

export async function unscheduleControlledExecution(executionId) {
  const res = await fetch(`${CONTROL_API}/executions/${encodeURIComponent(executionId)}/unschedule`, {
    method: 'POST',
  })
  const data = await res.json()
  if (!res.ok) {
    throw new Error(data.detail || 'Failed to unschedule execution')
  }
  return data.data
}

export async function repairControlledExecution(executionId) {
  const res = await fetch(`${CONTROL_API}/executions/${encodeURIComponent(executionId)}`)
  const data = await res.json()
  if (!res.ok) return false

  const engine = data.data?.engine
  const executor = data.data?.executor
  if (!engine || !['running', 'starting'].includes(String(engine.status || '').toLowerCase())) {
    return false
  }
  if (!executor?.executor_id || !engine.api_base_url) {
    return false
  }

  const listRes = await fetch(`${engine.api_base_url}/executors`)
  if (listRes.ok) {
    const listData = await listRes.json()
    if ((listData.data || []).some(row => row.executor_id === executor.executor_id)) {
      return false
    }
  }

  await ensureExecutorRegistered(engine, executor)
  return true
}

async function waitForEngine(engineId, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await fetch(`${CONTROL_API}/engines/${engineId}`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || 'Failed to read data-plane engine')
    const engine = data.data
    if (engine.status === 'running') return engine
    if (['failed', 'stopped', 'stale'].includes(engine.status)) {
      throw new Error(`Data-plane engine is ${engine.status}`)
    }
    await sleep(500)
  }
  throw new Error('Timed out waiting for data-plane heartbeat')
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function resolvePlaneWsUrl(plane) {
  const raw = String(plane?.ws_url || '').trim()
  if (!raw) return raw
  if (raw.startsWith('/')) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${window.location.host}${raw}`
  }
  if (plane?.id) {
    try {
      const url = new URL(raw)
      if (url.pathname === '/ws/live') {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        return `${protocol}//${window.location.host}/ws/control/engines/${plane.id}/live`
      }
    } catch {
      // fall through
    }
  }
  return raw
}

function filterActiveDataPlanes(engines) {
  return (engines || []).filter(engine =>
    ACTIVE_DATA_PLANE_STATUSES.has(String(engine.status || '').toLowerCase())
    && Number(engine.port) > 0
    && engine.api_base_url
    && engine.ws_url,
  )
}

function executionTimestamp() {
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function buildExecutionId(broker, symbol, strategyName) {
  const slug = `${broker}-${symbol}-strategy-${strategyName}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return `${slug}-${executionTimestamp()}`
}

function getPlaneStream(planeStreams, planeId) {
  if (!planeId) return EMPTY_PLANE_STREAM
  return planeStreams[planeId] || EMPTY_PLANE_STREAM
}

function resolveExecutionStream(stream, execution) {
  const planeId = execution?.data_plane_id
  const token = execution?.token
  const symbol = String(execution?.symbol || '').trim().toUpperCase()
  const primaryKey = planeTickKey(planeId, token)

  let tickHistory = stream.tickHistory[primaryKey] || []
  let tick = stream.ticks[primaryKey]
  let streamKey = primaryKey

  if ((!tickHistory.length || !tick) && planeId && symbol) {
    for (const [key, entry] of Object.entries(stream.ticks)) {
      if (!key.startsWith(`${planeId}:`)) continue
      if (String(entry?.symbol || '').trim().toUpperCase() !== symbol) continue
      tick = entry
      tickHistory = stream.tickHistory[key] || tickHistory
      streamKey = key
      break
    }
  }

  return { tickHistory, tick, streamKey }
}

export function resolveExecutionPriceStreamStatus({
  isStreaming,
  stream,
  streamKey,
  nowMs = Date.now(),
}) {
  if (!isStreaming) {
    return {
      status: 'offline',
      label: 'Price stream offline',
      detail: 'Deploy the strategy to start streaming.',
      tone: 'muted',
      lastTickAgeSec: null,
    }
  }
  if (!stream.connected) {
    if (stream.connectExhausted) {
      return {
        status: 'disconnected',
        label: 'Data plane unreachable',
        detail: 'WebSocket connection failed after several retries.',
        tone: 'error',
        lastTickAgeSec: null,
      }
    }
    return {
      status: 'connecting',
      label: 'Connecting to data plane…',
      detail: 'Waiting for WebSocket to the live engine.',
      tone: 'warn',
      lastTickAgeSec: null,
    }
  }

  const lastTickAt = streamKey ? stream.lastTickAt?.[streamKey] : null
  if (!lastTickAt) {
    const connectedForMs = stream.connectedAt ? nowMs - stream.connectedAt : 0
    if (connectedForMs >= PRICE_STREAM_FIRST_TICK_MS) {
      return {
        status: 'no_ticks',
        label: 'Connected — no prices received',
        detail: 'WebSocket is open but no tick messages have arrived yet.',
        tone: 'error',
        lastTickAgeSec: null,
      }
    }
    return {
      status: 'waiting',
      label: 'Connected — waiting for first tick…',
      detail: 'WebSocket open; awaiting first price from the live engine.',
      tone: 'warn',
      lastTickAgeSec: null,
    }
  }

  const ageMs = nowMs - lastTickAt
  const lastTickAgeSec = Math.max(0, Math.round(ageMs / 1000))
  if (ageMs > PRICE_STREAM_STALE_MS) {
    return {
      status: 'stale',
      label: `Prices stale (${lastTickAgeSec}s ago)`,
      detail: 'Ticks stopped arriving from the live engine.',
      tone: 'error',
      lastTickAgeSec,
    }
  }

  return {
    status: 'flowing',
    label: 'Live prices flowing',
    detail: `Last tick ${lastTickAgeSec}s ago.`,
    tone: 'ok',
    lastTickAgeSec,
  }
}

function PriceStreamStatusLine({ status }) {
  const toneClass = status.tone === 'ok'
    ? 'text-green'
    : status.tone === 'warn'
      ? 'text-yellow-400'
      : status.tone === 'error'
        ? 'text-red'
        : 'text-text-secondary'

  return (
    <div className="mt-0.5">
      <p className={`text-[10px] font-semibold ${toneClass}`}>{status.label}</p>
      {status.detail ? (
        <p className="text-[9px] text-text-secondary mt-0.5">{status.detail}</p>
      ) : null}
    </div>
  )
}

function useNow(intervalMs) {
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!intervalMs) return undefined
    const id = setInterval(() => setNowMs(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return nowMs
}

function buildChartSeries(history, execution, liveLtp) {
  const sanitized = sanitizeChartSeries(history)
  if (sanitized.length) return sanitized

  const price = Number(liveLtp ?? execution?.close_price)
  if (!Number.isFinite(price) || price <= 0) return []

  const now = Math.floor(Date.now() / 1000)
  return sanitizeChartSeries([
    { time: now - 180, value: price },
    { time: now - 60, value: price },
    { time: now, value: price },
  ])
}

function normalizeTokenKey(token) {
  if (token === null || token === undefined || token === '') return ''
  return String(token)
}

function planeTickKey(planeId, token) {
  const tokenKey = normalizeTokenKey(token)
  if (!planeId || !tokenKey) return tokenKey
  return `${planeId}:${tokenKey}`
}

function appendTickPoint(history, ltp) {
  const value = Number(ltp)
  if (!Number.isFinite(value) || value <= 0) return history

  const nextSec = Math.floor(Date.now() / 1000)
  const last = history[history.length - 1]
  if (last?.time === nextSec) {
    return [...history.slice(0, -1), { time: nextSec, value }]
  }
  if (last && last.time > nextSec) {
    return [...history.slice(-299), { time: last.time + 1, value }]
  }
  return [...history.slice(-299), { time: nextSec, value }]
}

function sanitizeChartSeries(points) {
  if (!points?.length) return []

  const sanitized = []
  for (const point of points) {
    const time = Number(point.time)
    const value = Number(point.value)
    if (!Number.isFinite(time) || !Number.isFinite(value) || value <= 0) continue

    const last = sanitized[sanitized.length - 1]
    if (last && time <= last.time) {
      sanitized[sanitized.length - 1] = { time: last.time + 1, value }
    } else {
      sanitized.push({ time, value })
    }
  }
  return sanitized
}

function getEventAction(event) {
  return String(
    event?.action
    || event?.activity_type
    || event?.event_type
    || (event?.type === 'order' ? 'ORDER_UPDATE' : '')
    || event?.type
    || '',
  ).toUpperCase()
}

function shouldNotifyAction(action) {
  if (!action) return false
  if (NOTIFY_ACTIONS.has(action)) return true
  return action.includes('ORDER_') || action.includes('POSITION_') || action.includes('_EXIT_')
}

function formatActionLabel(action = '') {
  return String(action).replace(/_/g, ' ')
}

function toastTone(action = '') {
  const value = String(action).toUpperCase()
  if (value.includes('FILLED') || value.includes('BUY_ORDER')) {
    return { icon: '▲', className: 'bg-green/90 border-green/40 text-white' }
  }
  if (value.includes('REJECT') || value.includes('CANCEL') || value.includes('STOP_LOSS')) {
    return { icon: '✕', className: 'bg-red/90 border-red/40 text-white' }
  }
  if (value.includes('CLOSE') || value.includes('TAKE_PROFIT') || value.includes('SELL')) {
    return { icon: '▼', className: 'bg-amber-500/90 border-amber-400/40 text-white' }
  }
  return { icon: '●', className: 'bg-accent/90 border-accent/40 text-white' }
}

function buildTradeMarkers(realtimeEvents, executorId, chartData) {
  if (!chartData.length) return []

  const tradeEvents = (realtimeEvents || [])
    .filter(evt => {
      const execId = evt.executor_id || evt.details?.executor_id
      if (execId && execId !== executorId) return false
      const action = getEventAction(evt)
      return shouldNotifyAction(action) || evt.type === 'order'
    })
    .slice(0, Math.min(8, chartData.length))

  const offset = chartData.length - tradeEvents.length
  return tradeEvents.map((evt, index) => {
    const point = chartData[offset + index] || chartData[chartData.length - 1]
    const action = getEventAction(evt)
    const isBuy = action.includes('BUY') || action === 'ORDER_FILLED'
    const isNegative = action.includes('REJECT') || action.includes('CANCEL') || action.includes('STOP_LOSS')
    return {
      time: point.time,
      position: isBuy ? 'belowBar' : 'aboveBar',
      color: isBuy ? '#00c853' : (isNegative ? '#ff1744' : '#ffb300'),
      shape: isBuy ? 'arrowUp' : 'arrowDown',
      text: formatActionLabel(action).slice(0, 12),
    }
  }).sort((a, b) => a.time - b.time)
}

function mergeLiveExecution(registryExecution, liveExecution) {
  const merged = { ...registryExecution, ...liveExecution }
  merged.created_at = registryExecution.created_at || liveExecution.created_at
  merged.source_id = registryExecution.source_id || liveExecution.source_id || 'user'
  merged.source_meta_id = registryExecution.source_meta_id || liveExecution.source_meta_id || null
  if (['running', 'starting'].includes(liveExecution.data_plane_status)) {
    merged.data_plane_id = liveExecution.data_plane_id || registryExecution.data_plane_id
    merged.data_plane_label = liveExecution.data_plane_label || registryExecution.data_plane_label
    merged.data_plane_port = liveExecution.data_plane_port || registryExecution.data_plane_port
    merged.data_plane_status = liveExecution.data_plane_status
    merged.api_base_url = liveExecution.api_base_url || registryExecution.api_base_url
    merged.ws_url = liveExecution.ws_url || registryExecution.ws_url
    merged.log_file = liveExecution.log_file || registryExecution.log_file
  }
  return merged
}

function normalizeControlledExecution(item) {
  const engine = item.engine || {}
  const executor = item.executor || engine.metadata?.executor_payload || {}
  const executorId = executor.executor_id || item.execution_id
  const plane = {
    id: engine.id || executorId,
    label: engine.label,
    port: engine.port || 0,
    status: engine.status || 'pending',
    api_base_url: engine.api_base_url || '',
    ws_url: engine.ws_url || '',
    metadata: engine.metadata,
    broker: engine.broker,
    account_env: engine.account_env,
    strategy_name: engine.strategy_name,
  }
  const engineStatus = String(engine.status || 'pending').toLowerCase()
  const metadata = engine.metadata || {}
  return normalizeExecution({
    ...executor,
    executor_id: executorId,
    source_id: metadata.source_id || metadata.execution_config?.source_id || 'user',
    source_meta_id: metadata.source_meta_id || metadata.execution_config?.source_meta_id || null,
    created_at: engine.created_at || null,
    started_at: engine.started_at || null,
    broker: engine.broker || executor.broker,
    symbol: engine.symbol || executor.symbol,
    token: engine.token || executor.token,
    exchange: executor.exchange || metadata.exchange,
    account_env: engine.account_env,
    strategy_name: engine.strategy_name,
    scheduled_start_at: metadata.scheduled_start_at || null,
    trading_day: metadata.trading_day || null,
    market_open_label: metadata.market_open_label || null,
    status: ['running', 'starting'].includes(engineStatus)
      ? (executor.status || 'RUNNING')
      : engineStatus.toUpperCase(),
  }, plane)
}

function normalizeExecution(executor, dataPlane = DEFAULT_DATA_PLANE) {
  const broker = executor.broker || dataPlane.broker || 'angel'
  const strategyName = executor.strategy_name || executor.strategy || dataPlane.strategy_name || 'default'
  return {
    ...executor,
    broker,
    data_plane_id: dataPlane.id,
    data_plane_label: dataPlane.label,
    data_plane_port: dataPlane.port,
    data_plane_status: dataPlane.status,
    api_base_url: dataPlane.api_base_url,
    ws_url: dataPlane.ws_url,
    log_file: dataPlane.metadata?.log_file || null,
    account_env: executor.account_env || dataPlane.account_env || 'live',
    client_mode: executor.client_mode || dataPlane.client_mode || 'standard',
    is_bracket_order_client: Boolean(executor.is_bracket_order_client || dataPlane.is_bracket_order_client),
    strategy_name: strategyName,
    label: executor.label || `${broker}-${executor.symbol}-strategy-${strategyName}`,
  }
}

function getPriceLines(execution) {
  const closePrice = Number(execution.close_price || 0)
  const initialThreshold = Number(execution.initial_threshold || 0)
  const longPercent = Number(execution.long_percent || 0)
  const shortPercent = Number(execution.short_percent || 0)
  const buyTrigger = closePrice ? closePrice * (1 + initialThreshold / 100) : null
  const takeProfit = buyTrigger ? buyTrigger * (1 + longPercent / 100) : null
  const stopLoss = buyTrigger ? buyTrigger * (1 - shortPercent / 100) : null

  return [
    closePrice && { price: closePrice, color: '#8899a6', lineStyle: 2, lineWidth: 1, title: 'CLOSE', axisLabelVisible: true },
    buyTrigger && { price: buyTrigger, color: '#1da1f2', lineStyle: 2, lineWidth: 1, title: 'BUY', axisLabelVisible: true },
    takeProfit && { price: takeProfit, color: '#00c853', lineStyle: 2, lineWidth: 1, title: 'TP', axisLabelVisible: true },
    stopLoss && { price: stopLoss, color: '#ff1744', lineStyle: 2, lineWidth: 1, title: 'SL', axisLabelVisible: true },
  ].filter(Boolean)
}

function eventColor(action = '') {
  const value = String(action).toUpperCase()
  if (value.includes('BUY') || value.includes('OPEN') || value.includes('FILLED')) return 'text-green'
  if (value.includes('SELL') || value.includes('CLOSE') || value.includes('CANCEL') || value.includes('ERROR')) return 'text-red'
  return 'text-accent'
}

function compactNumber(value, broker = 'angel') {
  return formatBrokerCompactMoney(broker, value)
}
