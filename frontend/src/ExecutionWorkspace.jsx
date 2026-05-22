import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createChart } from 'lightweight-charts'

const CONTROL_API = '/api/control'
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
  { id: 'launch', label: 'Launch' },
  { id: 'chart', label: 'Chart' },
  { id: 'portfolio', label: 'Portfolio' },
  { id: 'strategy', label: 'Strategy' },
  { id: 'orders', label: 'Order Management' },
  { id: 'events', label: 'Trading Events' },
  { id: 'history', label: 'History' },
]

export default function ExecutionWorkspace() {
  const [activeTab, setActiveTab] = useState('chart')
  const [executions, setExecutions] = useState([])
  const [dataPlanes, setDataPlanes] = useState([DEFAULT_DATA_PLANE])
  const [selectedDataPlaneId, setSelectedDataPlaneId] = useState(DEFAULT_DATA_PLANE.id)
  const [selectedExecutionId, setSelectedExecutionId] = useState(null)
  const [showCreate, setShowCreate] = useState(false)
  const [controlledExecutions, setControlledExecutions] = useState([])
  const [selectedLaunchId, setSelectedLaunchId] = useState(null)
  const [wsConnected, setWsConnected] = useState(false)
  const [ticks, setTicks] = useState({})
  const [tickHistory, setTickHistory] = useState({})
  const [realtimeEvents, setRealtimeEvents] = useState([])

  const wsRef = useRef(null)
  const reconnectRef = useRef(null)
  const dataPlanesRef = useRef(dataPlanes)

  useEffect(() => {
    dataPlanesRef.current = dataPlanes
  }, [dataPlanes])

  const selectedDataPlane = useMemo(
    () => dataPlanes.find(engine => engine.id === selectedDataPlaneId) || dataPlanes[0] || DEFAULT_DATA_PLANE,
    [dataPlanes, selectedDataPlaneId],
  )

  const selectedExecution = useMemo(
    () => executions.find(ex => ex.executor_id === selectedExecutionId) || null,
    [executions, selectedExecutionId],
  )

  const connectionPlane = useMemo(() => {
    if (selectedExecution?.data_plane_id && selectedExecution?.ws_url) {
      return {
        id: selectedExecution.data_plane_id,
        api_base_url: selectedExecution.api_base_url,
        ws_url: selectedExecution.ws_url,
        label: selectedExecution.data_plane_label,
        port: selectedExecution.data_plane_port,
        status: selectedExecution.data_plane_status,
      }
    }
    if (selectedDataPlane?.port > 0 && selectedDataPlane?.ws_url) {
      return selectedDataPlane
    }
    return null
  }, [selectedExecution, selectedDataPlane])

  const liveApi = connectionPlane?.api_base_url || ''
  const liveWs = connectionPlane?.ws_url || ''

  const executionEvents = useMemo(() => {
    if (!selectedExecution) return realtimeEvents
    return realtimeEvents.filter(event =>
      event.executor_id === selectedExecution.executor_id
      || event.details?.executor_id === selectedExecution.executor_id,
    )
  }, [realtimeEvents, selectedExecution])

  const selectedLaunch = useMemo(
    () => controlledExecutions.find(item => item.execution_id === selectedLaunchId) || controlledExecutions[0] || null,
    [controlledExecutions, selectedLaunchId],
  )

  const refreshControlledExecutions = useCallback(async () => {
    try {
      const res = await fetch(`${CONTROL_API}/executions`)
      const data = await res.json()
      const rows = data.status ? (data.data || []) : []
      setControlledExecutions(rows)
      setSelectedLaunchId(prev => {
        if (prev && rows.some(item => item.execution_id === prev)) return prev
        return rows[0]?.execution_id || null
      })
    } catch {
      setControlledExecutions([])
      setSelectedLaunchId(null)
    }
  }, [])

  const refreshDataPlanes = useCallback(async () => {
    try {
      const res = await fetch(`${CONTROL_API}/engines`)
      const data = await res.json()
      const engines = data.status && data.data?.length
        ? data.data.filter(engine => engine.status !== 'pending' && Number(engine.port) > 0)
        : [DEFAULT_DATA_PLANE]

      setDataPlanes(prev => {
        const next = engines.length ? engines : [DEFAULT_DATA_PLANE]
        const prevKey = JSON.stringify(prev.map(engine => [engine.id, engine.status, engine.port, engine.updated_at]))
        const nextKey = JSON.stringify(next.map(engine => [engine.id, engine.status, engine.port, engine.updated_at]))
        return prevKey === nextKey ? prev : next
      })
      setSelectedDataPlaneId(prev => {
        const list = engines.length ? engines : [DEFAULT_DATA_PLANE]
        if (prev && list.some(engine => engine.id === prev)) return prev
        return list[0]?.id || DEFAULT_DATA_PLANE.id
      })
    } catch {
      setDataPlanes([DEFAULT_DATA_PLANE])
      setSelectedDataPlaneId(DEFAULT_DATA_PLANE.id)
    }
  }, [])

  const refreshExecutions = useCallback(async () => {
    const planes = dataPlanesRef.current.filter(engine => Number(engine.port) > 0 && engine.status !== 'pending')
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
      const prevKey = JSON.stringify(prev.map(ex => [ex.executor_id, ex.status, ex.is_in_position, ex.data_plane_status]))
      const nextKey = JSON.stringify(allExecutions.map(ex => [ex.executor_id, ex.status, ex.is_in_position, ex.data_plane_status]))
      return prevKey === nextKey ? prev : allExecutions
    })
    setSelectedExecutionId(prev => {
      if (prev && allExecutions.some(ex => ex.executor_id === prev)) return prev
      return allExecutions[0]?.executor_id || null
    })
  }, [])

  useEffect(() => {
    refreshDataPlanes()
    refreshControlledExecutions()
    const intervalId = setInterval(refreshDataPlanes, 15000)
    return () => clearInterval(intervalId)
  }, [refreshDataPlanes, refreshControlledExecutions])

  const dataPlaneIdsKey = useMemo(
    () => dataPlanes.map(engine => `${engine.id}:${engine.status}:${engine.port}`).join('|'),
    [dataPlanes],
  )

  useEffect(() => {
    refreshExecutions()
    const intervalId = setInterval(refreshExecutions, 10000)
    return () => clearInterval(intervalId)
  }, [dataPlaneIdsKey, refreshExecutions])

  useEffect(() => {
    if (activeTab === 'launch' || !liveWs) {
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      setWsConnected(false)
      return undefined
    }

    let cancelled = false
    let socket = null
    const planeForMessages = connectionPlane || DEFAULT_DATA_PLANE
    const planeId = planeForMessages.id

    const handleMessage = (evt) => {
      const msg = JSON.parse(evt.data)
      if (msg.type === 'snapshot') {
        const snapshotExecutions = (msg.executors || []).map(execution =>
          normalizeExecution(execution, planeForMessages),
        )
        setExecutions(prev => {
          const others = prev.filter(ex => ex.data_plane_id !== planeId)
          const next = [...others, ...snapshotExecutions]
          const prevKey = JSON.stringify(prev.map(ex => [ex.executor_id, ex.status, ex.data_plane_id]))
          const nextKey = JSON.stringify(next.map(ex => [ex.executor_id, ex.status, ex.data_plane_id]))
          return prevKey === nextKey ? prev : next
        })
        setSelectedExecutionId(prev => prev || snapshotExecutions[0]?.executor_id || null)
        return
      }

      if (msg.type === 'tick') {
        setTicks(prev => ({ ...prev, [msg.token]: { symbol: msg.symbol, ltp: msg.ltp, exchange: msg.exchange } }))
        setTickHistory(prev => {
          const existing = prev[msg.token] || []
          const point = { time: Math.floor(Date.now() / 1000), value: Number(msg.ltp) }
          return { ...prev, [msg.token]: [...existing.slice(-299), point] }
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
        setRealtimeEvents(prev => [msg, ...prev].slice(0, 300))
      }
    }

    const connect = () => {
      if (cancelled) return
      socket = new WebSocket(liveWs)
      wsRef.current = socket

      socket.onopen = () => {
        if (!cancelled) setWsConnected(true)
      }

      socket.onclose = () => {
        setWsConnected(false)
        if (!cancelled) {
          reconnectRef.current = setTimeout(connect, 3000)
        }
      }

      socket.onmessage = handleMessage
    }

    setTicks({})
    setTickHistory({})
    setRealtimeEvents([])
    connect()

    return () => {
      cancelled = true
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      socket?.close()
      wsRef.current = null
    }
  }, [liveWs, activeTab, connectionPlane?.id])

  const createExecution = () => {
    setShowCreate(true)
    setActiveTab('strategy')
  }

  const onExecutionCreated = async (executionId) => {
    setShowCreate(false)
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

  return (
    <div className="h-full flex overflow-hidden bg-primary">
      <ExecutionSidePanel
        dataPlanes={dataPlanes}
        selectedDataPlaneId={selectedDataPlane.id}
        onSelectDataPlane={id => {
          setSelectedDataPlaneId(id)
          setShowCreate(false)
          setActiveTab('chart')
        }}
        executions={executions}
        selectedExecutionId={selectedExecution?.executor_id}
        wsConnected={wsConnected}
        connectionPlane={connectionPlane}
        onSelect={id => {
          const execution = executions.find(ex => ex.executor_id === id)
          setSelectedExecutionId(id)
          if (execution?.data_plane_id) {
            setSelectedDataPlaneId(execution.data_plane_id)
          }
          setShowCreate(false)
          setActiveTab('chart')
        }}
        onCreate={createExecution}
      />

      <main className="flex-1 flex flex-col overflow-hidden">
        <WorkspaceHeader
          execution={selectedExecution}
          dataPlane={connectionPlane || selectedDataPlane}
          wsConnected={wsConnected}
          liveApi={liveApi}
        />
        <TabBar activeTab={activeTab} setActiveTab={setActiveTab} />

        <section className="flex-1 overflow-auto">
          {showCreate ? (
            <CreateExecutionPanel onCreated={onExecutionCreated} onCancel={() => setShowCreate(false)} />
          ) : (
            <>
              {activeTab === 'launch' && (
                <LaunchTab
                  executions={controlledExecutions}
                  selectedLaunchId={selectedLaunch?.execution_id}
                  onSelect={setSelectedLaunchId}
                  onStarted={onExecutionStarted}
                  onRefresh={refreshControlledExecutions}
                />
              )}
              {activeTab === 'chart' && (
                <ChartTab
                  execution={selectedExecution}
                  connectionPlane={connectionPlane}
                  tickHistory={tickHistory}
                  realtimeEvents={executionEvents}
                />
              )}
              {activeTab === 'portfolio' && (
                <PortfolioTab liveApi={liveApi || DEFAULT_DATA_PLANE.api_base_url} ticks={ticks} execution={selectedExecution} />
              )}
              {activeTab === 'strategy' && (
                <StrategyTab
                  execution={selectedExecution}
                  latestTick={selectedExecution ? ticks[selectedExecution.token] : null}
                  liveApi={liveApi}
                  onCreate={createExecution}
                  onRefresh={refreshExecutions}
                />
              )}
              {activeTab === 'orders' && (
                <OrderManagementTab liveApi={liveApi || DEFAULT_DATA_PLANE.api_base_url} execution={selectedExecution} realtimeEvents={executionEvents} />
              )}
              {activeTab === 'events' && (
                <TradingEventsTab liveApi={liveApi || DEFAULT_DATA_PLANE.api_base_url} execution={selectedExecution} realtimeEvents={executionEvents} />
              )}
              {activeTab === 'history' && (
                <HistoricalEventsTab liveApi={liveApi || DEFAULT_DATA_PLANE.api_base_url} execution={selectedExecution} />
              )}
            </>
          )}
        </section>
      </main>
    </div>
  )
}

function ExecutionSidePanel({
  dataPlanes,
  selectedDataPlaneId,
  onSelectDataPlane,
  executions,
  selectedExecutionId,
  wsConnected,
  connectionPlane,
  onSelect,
  onCreate,
}) {
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
          <span className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-green' : 'bg-red'}`} />
          {wsConnected
            ? `Connected · port ${connectionPlane?.port || '-'}`
            : connectionPlane?.port
              ? 'Reconnecting...'
              : 'Select a running execution'}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-2">
        <div className="mb-4">
          <label className="text-[8px] uppercase tracking-widest text-text-secondary block mb-1">Data Plane</label>
          <select
            value={selectedDataPlaneId}
            onChange={event => onSelectDataPlane(event.target.value)}
            className="w-full bg-card border border-border rounded px-2 py-2 text-[10px] outline-none focus:border-accent"
          >
            {dataPlanes.map(engine => (
              <option key={engine.id} value={engine.id}>
                {engine.label || engine.id} ({engine.port || '-'}, {envLabel(engine.account_env)})
              </option>
            ))}
          </select>
        </div>

        {executions.map(ex => (
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
              <Metric label="Cap" value={compactNumber(ex.max_available_capital)} />
            </div>
          </button>
        ))}

        {!executions.length && (
          <div className="p-4 border border-dashed border-border rounded text-center">
            <p className="text-xs text-text-secondary mb-3">No active executions yet.</p>
            <button onClick={onCreate} className="px-3 py-1.5 bg-accent text-white rounded text-[10px] font-bold">
              Create Execution
            </button>
          </div>
        )}
      </div>
    </aside>
  )
}

function WorkspaceHeader({ execution, dataPlane, wsConnected, liveApi }) {
  return (
    <div className="px-5 py-3 bg-secondary border-b border-border flex items-center justify-between shrink-0">
      <div>
        <div className="text-sm font-bold">{execution?.label || 'No execution selected'}</div>
        <div className="text-[10px] text-text-secondary mt-0.5">
          {execution ? `${execution.symbol} · ${instrumentLabel(execution.broker)} ${execution.token || '-'} · ${execution.strategy_name}` : 'Create an execution to begin'}
          <span className="ml-2">· Live server :{dataPlane?.port || '-'}</span>
          {liveApi ? <span className="ml-2">· {liveApi}</span> : null}
          {execution?.log_file ? (
            <div className="mt-1 font-mono break-all">Log: {execution.log_file}</div>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <EnvBadge env={execution?.account_env || dataPlane?.account_env} />
        <span className="text-[9px] bg-card border border-border px-2 py-1 rounded font-bold">
          {(execution?.is_bracket_order_client || dataPlane?.is_bracket_order_client) ? 'BRACKET' : 'FEED TP/SL'}
        </span>
        {execution && execution.is_in_position && (
          <span className="text-[9px] bg-accent/20 text-accent px-2 py-1 rounded font-bold">IN POSITION</span>
        )}
        <span className={`text-[9px] px-2 py-1 rounded font-bold ${wsConnected ? 'bg-green/20 text-green' : 'bg-red/20 text-red'}`}>
          {wsConnected ? 'LIVE' : 'OFFLINE'}
        </span>
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

function ChartTab({ execution, connectionPlane, tickHistory, realtimeEvents }) {
  if (!execution) return <EmptyState title="No execution selected" body="Create or select an execution from the left panel." />
  if (!connectionPlane?.ws_url) {
    return <EmptyState title="Live server not running" body="Start this execution from the Launch tab to connect its websocket and chart." />
  }
  return (
    <div className="p-4 space-y-4">
      <div className="bg-card border border-border rounded">
        <LiveExecutionChart execution={execution} data={tickHistory[execution.token] || []} realtimeEvents={realtimeEvents} />
      </div>
      <ExecutionLevels execution={execution} />
    </div>
  )
}

function LiveExecutionChart({ execution, data, realtimeEvents }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const priceLinesRef = useRef([])

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 420,
      layout: { background: { color: '#111d28' }, textColor: '#8899a6' },
      grid: { vertLines: { color: '#1a2733' }, horzLines: { color: '#1a2733' } },
      timeScale: { timeVisible: true, secondsVisible: true, borderColor: '#2a3f52' },
      rightPriceScale: { borderColor: '#2a3f52' },
    })
    const series = chart.addLineSeries({ color: '#1da1f2', lineWidth: 2 })
    chartRef.current = chart
    seriesRef.current = series

    const resizeObserver = new ResizeObserver(() => {
      if (containerRef.current) chart.resize(containerRef.current.clientWidth, 420)
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      chart.remove()
    }
  }, [])

  useEffect(() => {
    if (!seriesRef.current) return
    seriesRef.current.setData(data)
    if (data.length) chartRef.current?.timeScale().scrollToPosition(2, false)
  }, [data])

  useEffect(() => {
    if (!seriesRef.current) return
    const series = seriesRef.current
    priceLinesRef.current.forEach(line => series.removePriceLine(line))
    priceLinesRef.current = getPriceLines(execution).map(line => series.createPriceLine(line))
  }, [execution])

  useEffect(() => {
    if (!seriesRef.current || !data.length) return
    const lastTime = data[data.length - 1].time
    const markers = realtimeEvents
      .filter(evt => evt.executor_id === execution.executor_id || evt.details?.executor_id === execution.executor_id)
      .slice(0, 20)
      .map(evt => {
        const action = evt.action || evt.type || ''
        const isBuy = action.includes('BUY')
        return {
          time: lastTime,
          position: isBuy ? 'belowBar' : 'aboveBar',
          color: isBuy ? '#00c853' : '#ff1744',
          shape: isBuy ? 'arrowUp' : 'arrowDown',
          text: action || 'EVENT',
        }
      })
    seriesRef.current.setMarkers(markers)
  }, [data, execution.executor_id, realtimeEvents])

  return <div ref={containerRef} className="w-full h-[420px]" />
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
          const liveLtp = ticks[holding.symboltoken]?.ltp
          const ltp = Number(liveLtp || holding.ltp || 0)
          const avg = Number(holding.averageprice || 0)
          const qty = Number(holding.quantity || 0)
          const pnl = (ltp - avg) * qty
          return [
            holding.tradingsymbol,
            holding.exchange,
            qty,
            ltp.toFixed(2),
            <span className={pnl >= 0 ? 'text-green' : 'text-red'}>{pnl.toFixed(2)}</span>,
          ]
        })}
      />
    </div>
  )
}

function ServerInfoPanel({ port, apiBaseUrl, wsUrl, logFile, pending = false }) {
  return (
    <div className="grid grid-cols-1 gap-2 text-xs bg-secondary border border-border rounded p-3">
      <div><span className="text-text-secondary">Port:</span> <span className="font-mono">{port || '-'}</span></div>
      <div><span className="text-text-secondary">API:</span> <span className="font-mono break-all">{apiBaseUrl || '-'}</span></div>
      {wsUrl ? (
        <div><span className="text-text-secondary">WebSocket:</span> <span className="font-mono break-all">{wsUrl}</span></div>
      ) : null}
      <div>
        <span className="text-text-secondary">Log file:</span>{' '}
        <span className="font-mono break-all">{logFile || (pending ? 'Created when live server starts' : '-')}</span>
      </div>
    </div>
  )
}

function StrategyTab({ execution, latestTick, liveApi, onCreate, onRefresh }) {
  if (!execution) {
    return (
      <EmptyState
        title="No strategy execution"
        body="Create a broker-stock-strategy execution to start monitoring strategy state."
        action={<button onClick={onCreate} className="px-4 py-2 bg-accent text-white rounded text-xs font-bold">Create Execution</button>}
      />
    )
  }

  return (
    <div className="p-4 space-y-4">
      <div className="grid grid-cols-6 gap-3">
        <StatCard label="Status" value={execution.status || 'UNKNOWN'} />
        <StatCard label="Env" value={envLabel(execution.account_env)} colorClass={execution.account_env === 'demo' ? 'text-accent' : 'text-red'} />
        <StatCard label="Client" value={execution.is_bracket_order_client ? 'Bracket' : 'Feed TP/SL'} />
        <StatCard label="Symbol" value={execution.symbol || '-'} />
        <StatCard label={instrumentLabel(execution.broker)} value={execution.token || '-'} colorClass="text-accent" />
        <StatCard label="LTP" value={latestTick ? latestTick.ltp.toFixed(2) : '-'} colorClass="text-accent" />
      </div>

      <ServerInfoPanel
        port={execution.data_plane_port}
        apiBaseUrl={execution.api_base_url || liveApi}
        wsUrl={execution.ws_url}
        logFile={execution.log_file}
        pending={!execution.log_file && !execution.data_plane_port}
      />

      <div className="bg-card border border-border rounded p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xs font-bold uppercase tracking-[1.5px]">Strategy Details</h3>
          <button onClick={onRefresh} className="text-[10px] text-accent hover:text-text-primary">Refresh</button>
        </div>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-xs">
          {Object.entries(execution)
            .filter(([key]) => !['api_base_url', 'ws_url', 'log_file', 'data_plane_id', 'data_plane_label', 'data_plane_port', 'data_plane_status'].includes(key))
            .map(([key, value]) => (
            <div key={key} className="flex justify-between gap-4 border-b border-border/30 pb-1">
              <dt className="text-text-secondary">{key}</dt>
              <dd className="font-mono text-right">{String(value ?? '-')}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}

function OrderManagementTab({ liveApi, execution, realtimeEvents }) {
  const [orders, setOrders] = useState({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`${liveApi}/orders`)
      .then(res => res.json())
      .then(data => { if (data.status) setOrders(data.data || {}) })
      .catch(() => setOrders({}))
      .finally(() => setLoading(false))
  }, [liveApi, realtimeEvents.length])

  if (loading) return <EmptyState title="Loading orders" body="Fetching current order manager state." />

  const rows = Object.entries(orders)
    .filter(([, order]) => !execution || order.executor_id === execution.executor_id)
    .map(([uid, order]) => [
      order.order_id || uid,
      order.unique_order_id || '-',
      order.executor_id || '-',
      order.order_type || '-',
      <StatusBadge status={(order.status || 'unknown').toUpperCase()} />,
    ])

  return (
    <div className="p-4">
      {rows.length ? (
        <DataTable columns={['Order ID', 'Unique ID', 'Execution', 'Type', 'Status']} rows={rows} />
      ) : (
        <EmptyState title="No orders tracked" body="Orders will appear here as the trading manager places and updates them." />
      )}
    </div>
  )
}

function TradingEventsTab({ liveApi, execution, realtimeEvents }) {
  const [dbEvents, setDbEvents] = useState([])

  useEffect(() => {
    fetch(`${liveApi}/events?limit=100`)
      .then(res => res.json())
      .then(data => { if (data.status) setDbEvents(data.data || []) })
      .catch(() => setDbEvents([]))
  }, [liveApi, realtimeEvents.length])

  const events = [...realtimeEvents, ...dbEvents]
    .filter(event => !execution || event.executor_id === execution.executor_id || event.details?.executor_id === execution.executor_id)
    .slice(0, 150)

  return <EventList events={events} emptyTitle="No trading events yet" />
}

function HistoricalEventsTab({ liveApi }) {
  const [sessions, setSessions] = useState([])
  const [selectedSessionId, setSelectedSessionId] = useState('')
  const [events, setEvents] = useState([])
  const [fallbackEvents, setFallbackEvents] = useState([])

  useEffect(() => {
    fetch(`${liveApi}/order-activity/sessions`)
      .then(res => (res.ok ? res.json() : Promise.reject(new Error('not wired'))))
      .then(data => {
        const rows = data.data || data.sessions || []
        setSessions(rows)
        setSelectedSessionId(rows[0]?.id || '')
      })
      .catch(() => {
        fetch(`${liveApi}/events?limit=100`)
          .then(res => res.json())
          .then(data => { if (data.status) setFallbackEvents(data.data || []) })
          .catch(() => setFallbackEvents([]))
      })
  }, [liveApi])

  useEffect(() => {
    if (!selectedSessionId) return
    fetch(`${liveApi}/order-activity/sessions/${selectedSessionId}/events?limit=300`)
      .then(res => res.json())
      .then(data => setEvents(data.data || data.events || []))
      .catch(() => setEvents([]))
  }, [liveApi, selectedSessionId])

  if (!sessions.length) {
    return (
      <div className="p-4">
        <div className="mb-3 text-[10px] text-text-secondary">
          Broker-agnostic order activity endpoints are not exposed yet; showing existing live event history.
        </div>
        <EventList events={fallbackEvents} emptyTitle="No historical events found" />
      </div>
    )
  }

  return (
    <div className="p-4 flex gap-4">
      <aside className="w-[280px] shrink-0 space-y-2">
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

function LaunchTab({ executions, selectedLaunchId, onSelect, onStarted, onRefresh }) {
  const selected = executions.find(item => item.execution_id === selectedLaunchId) || executions[0] || null
  const [starting, setStarting] = useState(false)
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
      const res = await fetch(`${CONTROL_API}/executions/${selected.execution_id}/start`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        setError(data.detail || 'Failed to start live server')
        return
      }

      const { engine, executor, port, log_file: logFile, api_base_url: apiBaseUrl } = data.data
      setStartInfo({ port, logFile, apiBaseUrl, engineId: engine.id })

      const runningEngine = await waitForEngine(engine.id)
      const executorRes = await fetch(`${runningEngine.api_base_url}/executors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(executor),
      })
      const executorData = await executorRes.json()
      if (!executorRes.ok) {
        setError(executorData.detail || 'Live server started, but executor registration failed')
        return
      }

      await onRefresh()
      onStarted(runningEngine, executor)
    } catch (err) {
      setError(err.message || 'Failed to start execution')
    } finally {
      setStarting(false)
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

  return (
    <div className="p-5 max-w-5xl">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-sm font-bold">Launch Execution</h2>
          <p className="text-[10px] text-text-secondary mt-1">
            Start the live server when you are ready. You will get the port and log file path.
          </p>
        </div>
        <button onClick={onRefresh} className="px-3 py-1.5 bg-card border border-border rounded text-[10px]">
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-[280px_1fr] gap-4">
        <aside className="space-y-2">
          {executions.map(item => (
            <button
              key={item.execution_id}
              onClick={() => onSelect(item.execution_id)}
              className={`w-full text-left p-3 rounded border ${
                selected?.execution_id === item.execution_id ? 'border-accent bg-accent/10' : 'border-border bg-card'
              }`}
            >
              <div className="text-[11px] font-bold truncate">{item.engine?.label || item.execution_id}</div>
              <div className="text-[9px] text-text-secondary mt-1 truncate">{item.execution_id}</div>
              <div className="mt-2"><StatusBadge status={item.engine?.status || 'pending'} /></div>
            </button>
          ))}
        </aside>

        <div className="bg-card border border-border rounded p-4 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-bold">{engine.label || selected.execution_id}</div>
              <div className="text-[10px] text-text-secondary mt-1">
                {executor.symbol || engine.symbol} · {instrumentLabel(engine.broker)} {executor.token || engine.token}
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

          <ServerInfoPanel
            port={startInfo?.port || engine.port}
            apiBaseUrl={startInfo?.apiBaseUrl || engine.api_base_url}
            wsUrl={engine.ws_url}
            logFile={startInfo?.logFile || engine.metadata?.log_file}
            pending={status === 'PENDING' && !(startInfo?.logFile || engine.metadata?.log_file)}
          />

          {error && <div className="text-xs text-red">{error}</div>}

          <div className="flex items-center gap-3">
            <button
              onClick={startExecution}
              disabled={starting || !canStart}
              className="px-5 py-2 bg-green text-white rounded text-xs font-bold disabled:opacity-50"
            >
              {starting ? 'Starting live server...' : status === 'RUNNING' ? 'Already running' : 'Start Live Server'}
            </button>
            {!canStart && status !== 'RUNNING' && (
              <span className="text-[10px] text-text-secondary">Status: {status}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function CreateExecutionPanel({ onCreated, onCancel }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [selectedStock, setSelectedStock] = useState(null)
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
    use_fake_client: false,
    client_mode: 'standard',
  })
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const search = async () => {
    if (!query.trim()) return
    setError('')
    const params = new URLSearchParams({
      q: query.trim(),
      broker: form.broker,
      account_env: form.account_env,
      exchange: 'NSE',
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
      if (!(data.data || []).length) setError(`No results found for "${query.trim()}"`)
    } catch (err) {
      console.error('[CreateExecution] Search request failed', err)
      setError(err.message || 'Search request failed')
      setResults([])
    }
  }

  const selectStock = stock => {
    setSelectedStock(stock)
    const nextId = `${form.broker}-${stock.tradingsymbol}-strategy-${form.strategy_name}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
    setForm(prev => ({ ...prev, executor_id: nextId }))
    setResults([])
    setQuery('')
  }

  const submit = async () => {
    if (!selectedStock) { setError('Select a stock first'); return }
    if (!Number(form.close_price)) { setError('Close price is required'); return }

    setSubmitting(true)
    setError('')
    try {
      const res = await fetch(`${CONTROL_API}/executions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
          use_fake_client: form.use_fake_client,
          client_mode: form.broker === 'etoro' ? form.client_mode : 'standard',
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.detail || 'Failed to create execution')
        return
      }
      onCreated(data.data.execution_id)
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="p-5 max-w-4xl">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-sm font-bold">Create Execution</h2>
          <p className="text-[10px] text-text-secondary mt-1">Save the execution config. Start the live server from the Launch tab.</p>
        </div>
        <button onClick={onCancel} className="text-xs text-text-secondary hover:text-text-primary">Cancel</button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <FormField label="Broker" value={form.broker} onChange={value => setForm(prev => ({ ...prev, broker: value }))} />
        <div>
          <label className="text-[9px] uppercase tracking-[1.5px] text-text-secondary block mb-1">Environment</label>
          <select
            value={form.account_env}
            onChange={e => setForm(prev => ({ ...prev, account_env: e.target.value }))}
            className="w-full px-3 py-2 bg-card border border-border rounded text-xs outline-none focus:border-accent"
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
            className="w-full px-3 py-2 bg-card border border-border rounded text-xs outline-none focus:border-accent disabled:opacity-50"
          >
            <option value="standard">Standard (feed TP/SL)</option>
            <option value="bracket">Bracket Order</option>
          </select>
        </div>
        <FormField label="Execution ID" value={form.executor_id} onChange={value => setForm(prev => ({ ...prev, executor_id: value }))} />

        <div className="col-span-3">
          <label className="text-[9px] uppercase tracking-[1.5px] text-text-secondary block mb-1">Stock</label>
          <div className="flex gap-2">
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && search()}
              placeholder="Search stock"
              className="flex-1 px-3 py-2 bg-card border border-border rounded text-xs outline-none focus:border-accent"
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

        <FormField label="Close Price" type="number" value={form.close_price} onChange={value => setForm(prev => ({ ...prev, close_price: value }))} />
        <FormField label="Initial Threshold %" type="number" value={form.initial_threshold} onChange={value => setForm(prev => ({ ...prev, initial_threshold: value }))} />
        <FormField label="Capital" type="number" value={form.max_available_capital} onChange={value => setForm(prev => ({ ...prev, max_available_capital: value }))} />
        <FormField label="Take Profit %" type="number" value={form.long_percent} onChange={value => setForm(prev => ({ ...prev, long_percent: value }))} />
        <FormField label="Stop Loss %" type="number" value={form.short_percent} onChange={value => setForm(prev => ({ ...prev, short_percent: value }))} />
        <label className="flex items-center gap-2 text-xs text-text-secondary">
          <input
            type="checkbox"
            checked={form.use_fake_client}
            onChange={e => setForm(prev => ({ ...prev, use_fake_client: e.target.checked }))}
          />
          Use fake broker client
        </label>
      </div>

      {error && <div className="mt-4 text-xs text-red">{error}</div>}
      <button onClick={submit} disabled={submitting} className="mt-5 px-5 py-2 bg-green text-white rounded text-xs font-bold disabled:opacity-50">
        {submitting ? 'Creating...' : 'Create Execution'}
      </button>
    </div>
  )
}

function EventList({ events, emptyTitle }) {
  if (!events.length) return <EmptyState title={emptyTitle} body="Realtime and persisted events will appear here." />
  return (
    <div className="space-y-1">
      {events.map((event, index) => {
        const action = event.action || event.activity_type || event.event_type || event.type
        const details = event.details || event.content || event.raw_json || event.raw || {}
        return (
          <div key={`${action}-${index}`} className="px-3 py-2 bg-card border border-border/50 rounded text-xs flex items-center gap-3">
            <span className="w-36 shrink-0 text-[9px] text-text-secondary font-mono">
              {event.created_at || event.received_at || new Date().toLocaleTimeString()}
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
  const closePrice = Number(execution.close_price || 0)
  const buyTrigger = closePrice ? closePrice * (1 + Number(execution.initial_threshold || 0) / 100) : null
  const takeProfit = buyTrigger ? buyTrigger * (1 + Number(execution.long_percent || 0) / 100) : null
  const stopLoss = buyTrigger ? buyTrigger * (1 - Number(execution.short_percent || 0) / 100) : null

  return (
    <div className="grid grid-cols-4 gap-3">
      <StatCard label="Previous Close" value={closePrice ? closePrice.toFixed(2) : '-'} />
      <StatCard label="Buy Trigger" value={buyTrigger ? buyTrigger.toFixed(2) : '-'} colorClass="text-accent" />
      <StatCard label="Take Profit" value={takeProfit ? takeProfit.toFixed(2) : '-'} colorClass="text-green" />
      <StatCard label="Stop Loss" value={stopLoss ? stopLoss.toFixed(2) : '-'} colorClass="text-red" />
    </div>
  )
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
        className="w-full px-3 py-2 bg-card border border-border rounded text-xs outline-none focus:border-accent"
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

function EmptyState({ title, body, action }) {
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

async function waitForEngine(engineId, timeoutMs = 15000) {
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

function compactNumber(value) {
  const number = Number(value || 0)
  if (!number) return '-'
  if (number >= 100000) return `${(number / 100000).toFixed(1)}L`
  if (number >= 1000) return `${(number / 1000).toFixed(0)}K`
  return String(number)
}
