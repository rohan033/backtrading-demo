import { useState, useEffect, useRef, useCallback } from 'react'
import { createChart } from 'lightweight-charts'

const LIVE_API = '/api/live'
const LIVE_WS = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/live`

const TABS = [
  { id: 'portfolio', label: 'Portfolio' },
  { id: 'search', label: 'Stock Search' },
  { id: 'strategies', label: 'Strategies' },
  { id: 'orders', label: 'Order Status' },
  { id: 'events', label: 'Events' },
  { id: 'trades', label: 'Trades' },
]

export default function LiveTrading() {
  const [tab, setTab] = useState('strategies')
  const [wsConnected, setWsConnected] = useState(false)
  const wsRef = useRef(null)
  const reconnectRef = useRef(null)

  // Shared state updated by WebSocket
  const [executors, setExecutors] = useState([])
  const [ticks, setTicks] = useState({}) // token -> {symbol, ltp}
  const [tickHistory, setTickHistory] = useState({}) // token -> [{time, value}]
  const [realtimeEvents, setRealtimeEvents] = useState([])

  // Connect WebSocket
  const connectWs = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const ws = new WebSocket(LIVE_WS)
    wsRef.current = ws

    ws.onopen = () => {
      setWsConnected(true)
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
    }

    ws.onclose = () => {
      setWsConnected(false)
      reconnectRef.current = setTimeout(connectWs, 3000)
    }

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data)
      switch (msg.type) {
        case 'snapshot':
          setExecutors(msg.executors || [])
          break
        case 'tick':
          setTicks(prev => ({ ...prev, [msg.token]: { symbol: msg.symbol, ltp: msg.ltp } }))
          setTickHistory(prev => {
            const existing = prev[msg.token] || []
            const point = { time: Math.floor(Date.now() / 1000), value: msg.ltp }
            return { ...prev, [msg.token]: [...existing.slice(-299), point] }
          })
          break
        case 'executor_status':
          setExecutors(prev => prev.map(ex =>
            ex.executor_id === msg.executor_id
              ? { ...ex, status: msg.status, is_in_position: msg.is_in_position }
              : ex
          ))
          break
        case 'order':
        case 'event':
          setRealtimeEvents(prev => [msg, ...prev].slice(0, 200))
          break
      }
    }
  }, [])

  useEffect(() => {
    connectWs()
    return () => {
      if (wsRef.current) wsRef.current.close()
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
    }
  }, [connectWs])

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-4 py-2 bg-secondary border-b border-border">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-1 rounded text-[10px] font-bold transition-colors ${
              tab === t.id
                ? 'bg-accent text-white'
                : 'bg-card text-text-secondary hover:text-text'
            }`}
          >
            {t.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-green' : 'bg-red'}`} />
          <span className="text-[9px] text-text-secondary">
            {wsConnected ? 'CONNECTED' : 'DISCONNECTED'}
          </span>
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-4">
        {tab === 'portfolio' && <PortfolioTab ticks={ticks} />}
        {tab === 'search' && <SearchTab onRegistered={() => fetchExecutors(setExecutors)} />}
        {tab === 'strategies' && <StrategiesTab executors={executors} setExecutors={setExecutors} ticks={ticks} tickHistory={tickHistory} realtimeEvents={realtimeEvents} />}
        {tab === 'orders' && <OrdersTab />}
        {tab === 'events' && <EventsTab realtimeEvents={realtimeEvents} />}
        {tab === 'trades' && <TradesTab />}
      </div>
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchExecutors(setExecutors) {
  try {
    const res = await fetch(`${LIVE_API}/executors`)
    const data = await res.json()
    if (data.status) setExecutors(data.data)
  } catch (e) { /* ignore */ }
}

function StatusBadge({ status }) {
  const colors = {
    RUNNING: 'bg-green/20 text-green',
    POSITION_OPEN: 'bg-accent/20 text-accent',
    STOPPED: 'bg-red/20 text-red',
  }
  return (
    <span className={`px-2 py-0.5 rounded text-[9px] font-bold ${colors[status] || 'bg-card text-text-secondary'}`}>
      {status}
    </span>
  )
}

// ─── Portfolio Tab ────────────────────────────────────────────────────────────

function PortfolioTab({ ticks }) {
  const [holdings, setHoldings] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`${LIVE_API}/portfolio`)
      .then(r => r.json())
      .then(d => { if (d.status) setHoldings(d.data || []) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <p className="text-text-secondary text-sm">Loading portfolio...</p>
  if (!holdings.length) return <p className="text-text-secondary text-sm">No holdings found</p>

  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-text-secondary border-b border-border">
          <th className="text-left py-2 px-2">Symbol</th>
          <th className="text-right py-2 px-2">Qty</th>
          <th className="text-right py-2 px-2">LTP</th>
          <th className="text-right py-2 px-2">P&L</th>
        </tr>
      </thead>
      <tbody>
        {holdings.map(h => {
          const liveLtp = ticks[h.symboltoken]?.ltp
          const ltp = liveLtp || parseFloat(h.ltp || 0)
          const avg = parseFloat(h.averageprice || 0)
          const qty = parseInt(h.quantity || 0)
          const pnl = (ltp - avg) * qty
          return (
            <tr key={h.symboltoken} className="border-b border-border/50 hover:bg-card">
              <td className="py-2 px-2 font-medium">{h.tradingsymbol}</td>
              <td className="text-right py-2 px-2">{qty}</td>
              <td className="text-right py-2 px-2">{ltp.toFixed(2)}</td>
              <td className={`text-right py-2 px-2 font-medium ${pnl >= 0 ? 'text-green' : 'text-red'}`}>
                {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// ─── Search Tab ───────────────────────────────────────────────────────────────

function SearchTab({ onRegistered }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [showForm, setShowForm] = useState(null) // selected result for registration

  const search = async () => {
    if (!query.trim()) return
    setSearching(true)
    try {
      const res = await fetch(`${LIVE_API}/search?q=${encodeURIComponent(query)}&exchange=NSE`)
      const data = await res.json()
      setResults(data.data || [])
    } catch (e) { setResults([]) }
    setSearching(false)
  }

  return (
    <div>
      <div className="flex gap-2 mb-4">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && search()}
          placeholder="Search symbol..."
          className="flex-1 bg-card border border-border rounded px-3 py-1.5 text-sm text-text focus:border-accent outline-none"
        />
        <button onClick={search} disabled={searching}
          className="px-4 py-1.5 bg-accent text-white rounded text-xs font-bold hover:bg-accent/80 disabled:opacity-50">
          {searching ? '...' : 'Search'}
        </button>
      </div>

      {results.length > 0 && (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-text-secondary border-b border-border">
              <th className="text-left py-2 px-2">Symbol</th>
              <th className="text-left py-2 px-2">Token</th>
              <th className="text-left py-2 px-2">Exchange</th>
              <th className="text-right py-2 px-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {results.slice(0, 20).map(r => (
              <tr key={r.symboltoken} className="border-b border-border/50 hover:bg-card">
                <td className="py-2 px-2 font-medium">{r.tradingsymbol}</td>
                <td className="py-2 px-2 text-text-secondary">{r.symboltoken}</td>
                <td className="py-2 px-2 text-text-secondary">{r.exchange}</td>
                <td className="text-right py-2 px-2">
                  <button
                    onClick={() => setShowForm(r)}
                    className="px-2 py-0.5 bg-green/20 text-green rounded text-[9px] font-bold hover:bg-green/30">
                    Register
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showForm && (
        <RegisterForm
          symbol={showForm.tradingsymbol}
          token={showForm.symboltoken}
          exchange={showForm.exchange || 'NSE'}
          onClose={() => setShowForm(null)}
          onRegistered={onRegistered}
        />
      )}
    </div>
  )
}

function RegisterForm({ symbol, token, exchange, onClose, onRegistered }) {
  const [form, setForm] = useState({
    executor_id: `${symbol.toLowerCase().replace(/[^a-z0-9]/g, '-')}-1`,
    long_percent: '1.0',
    short_percent: '10.0',
    stop_loss_amount: '',
    initial_threshold: '0.2',
    max_available_capital: '100000',
    close_price: '',
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    const cp = parseFloat(form.close_price)
    if (!cp) { setError('Close price is required'); return }
    setSubmitting(true)
    setError('')
    try {
      const payload = {
        executor_id: form.executor_id,
        close_price: cp,
        max_available_capital: parseFloat(form.max_available_capital) || 100000,
        initial_threshold: parseFloat(form.initial_threshold) || 0.2,
        long_percent: parseFloat(form.long_percent) || 1.0,
        short_percent: parseFloat(form.short_percent) || 10.0,
        stop_loss_amount: parseFloat(form.stop_loss_amount) > 0 ? parseFloat(form.stop_loss_amount) : null,
        symbol, token, exchange,
      }
      const res = await fetch(`${LIVE_API}/executors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.detail || 'Failed'); setSubmitting(false); return }
      onRegistered()
      onClose()
    } catch (e) { setError(e.message) }
    setSubmitting(false)
  }

  const updateField = (field, value) => {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  return (
    <div className="mt-4 p-4 bg-card border border-border rounded">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold">Register Executor: <span className="text-accent">{symbol}</span></h3>
        <button onClick={onClose} className="text-text-secondary hover:text-text text-xs">Close</button>
      </div>
      <div className="grid grid-cols-3 gap-3 mb-3">
        <div className="flex flex-col gap-1">
          <label className="text-[9px] text-text-secondary uppercase tracking-wider">Executor ID</label>
          <input type="text" value={form.executor_id} onChange={e => updateField('executor_id', e.target.value)}
            className="bg-primary border border-border rounded px-2 py-1 text-xs text-text focus:border-accent outline-none" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[9px] text-text-secondary uppercase tracking-wider">Close Price</label>
          <input type="number" step="0.01" value={form.close_price} onChange={e => updateField('close_price', e.target.value)}
            placeholder="Required"
            className="bg-primary border border-border rounded px-2 py-1 text-xs text-text focus:border-accent outline-none" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[9px] text-text-secondary uppercase tracking-wider">Capital</label>
          <input type="number" step="1000" value={form.max_available_capital} onChange={e => updateField('max_available_capital', e.target.value)}
            className="bg-primary border border-border rounded px-2 py-1 text-xs text-text focus:border-accent outline-none" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[9px] text-text-secondary uppercase tracking-wider">Threshold %</label>
          <input type="number" step="0.1" value={form.initial_threshold} onChange={e => updateField('initial_threshold', e.target.value)}
            className="bg-primary border border-border rounded px-2 py-1 text-xs text-text focus:border-accent outline-none" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[9px] text-text-secondary uppercase tracking-wider">Take Profit %</label>
          <input type="number" step="0.1" value={form.long_percent} onChange={e => updateField('long_percent', e.target.value)}
            className="bg-primary border border-border rounded px-2 py-1 text-xs text-text focus:border-accent outline-none" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[9px] text-text-secondary uppercase tracking-wider">Stop Loss Amount</label>
          <input type="number" step="1" value={form.stop_loss_amount} onChange={e => updateField('stop_loss_amount', e.target.value)}
            placeholder="Optional (USD)"
            className="bg-primary border border-border rounded px-2 py-1 text-xs text-text focus:border-accent outline-none" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[9px] text-text-secondary uppercase tracking-wider">Stop Loss %</label>
          <input type="number" step="0.1" value={form.short_percent} onChange={e => updateField('short_percent', e.target.value)}
            disabled={parseFloat(form.stop_loss_amount) > 0}
            className="bg-primary border border-border rounded px-2 py-1 text-xs text-text focus:border-accent outline-none disabled:opacity-50" />
        </div>
      </div>
      {error && <p className="text-red text-xs mb-2">{error}</p>}
      <button onClick={submit} disabled={submitting}
        className="px-4 py-1.5 bg-green text-white rounded text-xs font-bold hover:bg-green/80 disabled:opacity-50">
        {submitting ? 'Registering...' : 'Register Executor'}
      </button>
    </div>
  )
}

// ─── Live LTP Chart ───────────────────────────────────────────────────────────

function LiveChart({ token, tickHistory, executor, realtimeEvents }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const markersRef = useRef([])

  // Compute price levels from executor config
  const closePrice = executor?.close_price || 0
  const threshold = executor?.initial_threshold || 0
  const longPct = executor?.long_percent || 0
  const shortPct = executor?.short_percent || 0

  const buyTriggerPrice = closePrice ? closePrice * (1 + threshold / 100) : null
  // TP/SL are relative to entry price (buy trigger), not close
  const tpPrice = buyTriggerPrice ? buyTriggerPrice * (1 + longPct / 100) : null
  const slPrice = buyTriggerPrice ? buyTriggerPrice * (1 - shortPct / 100) : null

  useEffect(() => {
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 300,
      layout: { background: { color: '#0f1923' }, textColor: '#8899a6' },
      grid: { vertLines: { color: '#1a2733' }, horzLines: { color: '#1a2733' } },
      timeScale: { timeVisible: true, secondsVisible: true, borderColor: '#2a3a4a' },
      rightPriceScale: { borderColor: '#2a3a4a' },
      crosshair: { mode: 0 },
    })

    const series = chart.addLineSeries({
      color: '#1da1f2',
      lineWidth: 2,
      priceLineVisible: true,
      lastValueVisible: true,
    })

    chartRef.current = chart
    seriesRef.current = series

    const resizeObserver = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth })
      }
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      chart.remove()
    }
  }, [])

  // Update price lines when executor config changes
  useEffect(() => {
    if (!seriesRef.current) return

    const lines = []

    if (closePrice) {
      lines.push({
        price: closePrice,
        color: '#8899a6',
        lineWidth: 1,
        lineStyle: 2, // dashed
        axisLabelVisible: true,
        title: 'CLOSE',
      })
    }
    if (buyTriggerPrice) {
      lines.push({
        price: buyTriggerPrice,
        color: '#ffab00',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'BUY TRIGGER',
      })
    }
    if (tpPrice) {
      lines.push({
        price: tpPrice,
        color: '#00c853',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'TAKE PROFIT',
      })
    }
    if (slPrice) {
      lines.push({
        price: slPrice,
        color: '#ff1744',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'STOP LOSS',
      })
    }

    // Remove old price lines and add new ones
    const series = seriesRef.current
    // createPriceLine returns a reference we need to track
    // Clear existing by recreating (lightweight-charts doesn't have removeAllPriceLines)
    lines.forEach(opts => {
      try { series.createPriceLine(opts) } catch(e) {}
    })
  }, [closePrice, buyTriggerPrice, tpPrice, slPrice])

  // Update data + markers
  useEffect(() => {
    if (!seriesRef.current) return
    const data = tickHistory[token] || []
    if (data.length > 0) {
      seriesRef.current.setData(data)

      // Add buy/sell markers from realtime events
      const executorId = executor?.executor_id
      const orderEvents = (realtimeEvents || []).filter(
        e => e.type === 'order' && e.executor_id === executorId
      )
      const markers = orderEvents.map(evt => {
        const time = Math.floor(Date.now() / 1000)
        const isBuy = evt.action?.includes('BUY')
        return {
          time,
          position: isBuy ? 'belowBar' : 'aboveBar',
          color: isBuy ? '#00c853' : '#ff1744',
          shape: isBuy ? 'arrowUp' : 'arrowDown',
          text: isBuy ? 'BUY' : 'SELL',
        }
      }).sort((a, b) => a.time - b.time)

      if (markers.length > 0) {
        seriesRef.current.setMarkers(markers)
      }
    }
  }, [tickHistory, token, realtimeEvents])

  return <div ref={containerRef} className="w-full h-[300px]" />
}

// ─── Strategies Tab ───────────────────────────────────────────────────────────

function StrategiesTab({ executors, setExecutors, ticks, tickHistory, realtimeEvents }) {
  useEffect(() => { fetchExecutors(setExecutors) }, [])

  const stopExecutor = async (id) => {
    try {
      await fetch(`${LIVE_API}/executors/${id}`, { method: 'DELETE' })
      setExecutors(prev => prev.filter(ex => ex.executor_id !== id))
    } catch (e) { /* ignore */ }
  }

  if (!executors.length) {
    return <p className="text-text-secondary text-sm">No executors registered. Go to Stock Search to add one.</p>
  }

  return (
    <div className="space-y-3">
      {executors.map(ex => (
        <div key={ex.executor_id} className="bg-card border border-border rounded overflow-hidden">
          <div className="p-3 flex items-center gap-4">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-bold">{ex.symbol}</span>
                <StatusBadge status={ex.status} />
                {ex.is_in_position && (
                  <span className="text-[9px] bg-accent/20 text-accent px-1.5 py-0.5 rounded font-bold">IN POSITION</span>
                )}
              </div>
              <div className="text-[10px] text-text-secondary flex gap-4">
                <span>ID: {ex.executor_id}</span>
                <span>Threshold: {ex.initial_threshold}%</span>
                <span>TP: {ex.long_percent}%</span>
                <span>SL: {ex.short_percent}%</span>
                <span>Capital: {ex.max_available_capital?.toLocaleString()}</span>
                {ticks[ex.token] && <span className="text-accent font-bold">LTP: {ticks[ex.token].ltp.toFixed(2)}</span>}
              </div>
            </div>
            <button
              onClick={() => stopExecutor(ex.executor_id)}
              className="px-3 py-1 bg-red/20 text-red rounded text-[9px] font-bold hover:bg-red/30">
              Stop
            </button>
          </div>
          <div className="border-t border-border">
            <LiveChart token={ex.token} tickHistory={tickHistory} executor={ex} realtimeEvents={realtimeEvents} />
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Orders Tab ───────────────────────────────────────────────────────────────

function OrdersTab() {
  const [orders, setOrders] = useState({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`${LIVE_API}/orders`)
      .then(r => r.json())
      .then(d => { if (d.status) setOrders(d.data || {}) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <p className="text-text-secondary text-sm">Loading...</p>

  const entries = Object.entries(orders)
  if (!entries.length) return <p className="text-text-secondary text-sm">No orders tracked yet.</p>

  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-text-secondary border-b border-border">
          <th className="text-left py-2 px-2">Order ID</th>
          <th className="text-left py-2 px-2">Executor</th>
          <th className="text-left py-2 px-2">Type</th>
          <th className="text-left py-2 px-2">Status</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([uid, o]) => (
          <tr key={uid} className="border-b border-border/50 hover:bg-card">
            <td className="py-2 px-2 font-mono">{o.order_id}</td>
            <td className="py-2 px-2">{o.executor_id}</td>
            <td className="py-2 px-2">{o.order_type}</td>
            <td className="py-2 px-2"><StatusBadge status={o.status?.toUpperCase() || 'UNKNOWN'} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ─── Events Tab ───────────────────────────────────────────────────────────────

function EventsTab({ realtimeEvents }) {
  const [dbEvents, setDbEvents] = useState([])

  useEffect(() => {
    fetch(`${LIVE_API}/events?limit=50`)
      .then(r => r.json())
      .then(d => { if (d.status) setDbEvents(d.data || []) })
      .catch(() => {})
  }, [])

  const allEvents = [...realtimeEvents, ...dbEvents].slice(0, 100)

  if (!allEvents.length) return <p className="text-text-secondary text-sm">No events yet.</p>

  return (
    <div className="space-y-1">
      {allEvents.map((evt, i) => (
        <div key={i} className="px-3 py-2 bg-card border border-border/50 rounded text-xs flex items-center gap-3">
          <span className="text-text-secondary font-mono text-[9px] w-20 shrink-0">
            {evt.created_at || new Date().toLocaleTimeString()}
          </span>
          <span className={`font-bold text-[10px] w-32 shrink-0 ${
            (evt.action || evt.type)?.includes('PLACED') ? 'text-green' :
            (evt.action || evt.type)?.includes('FAILED') ? 'text-red' : 'text-accent'
          }`}>
            {evt.action || evt.type}
          </span>
          <span className="text-text-secondary truncate">
            {evt.order_id && `order=${evt.order_id}`}
            {evt.executor_id && ` executor=${evt.executor_id}`}
            {evt.symbol && ` ${evt.symbol}`}
            {evt.entry_price && ` price=${evt.entry_price}`}
          </span>
        </div>
      ))}
    </div>
  )
}

// ─── Trades Tab ───────────────────────────────────────────────────────────────

function TradesTab() {
  const [trades, setTrades] = useState([])
  const [positions, setPositions] = useState([])
  const [summary, setSummary] = useState({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      fetch(`${LIVE_API}/trades`).then(r => r.json()),
      fetch(`${LIVE_API}/positions`).then(r => r.json()),
      fetch(`${LIVE_API}/summary`).then(r => r.json()),
    ]).then(([t, p, s]) => {
      if (t.status) setTrades(t.data || [])
      if (p.status) setPositions(p.data || [])
      if (s.status) setSummary(s.data || {})
    }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  if (loading) return <p className="text-text-secondary text-sm">Loading...</p>

  return (
    <div>
      {/* Summary cards */}
      {Object.keys(summary).length > 0 && (
        <div className="flex gap-3 mb-4">
          {Object.entries(summary).map(([action, stats]) => (
            <div key={action} className="px-3 py-2 bg-card border border-border rounded">
              <div className="text-[9px] text-text-secondary uppercase">{action}</div>
              <div className="text-sm font-bold">{stats.count} orders</div>
              <div className="text-[10px] text-text-secondary">
                qty: {stats.total_quantity} | avg: {stats.avg_price?.toFixed(2)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Active positions */}
      {positions.length > 0 && (
        <div className="mb-4">
          <h3 className="text-[9px] uppercase tracking-wider text-text-secondary mb-2">Active Positions</h3>
          <div className="space-y-1">
            {positions.map((p, i) => (
              <div key={i} className="px-3 py-2 bg-green/5 border border-green/20 rounded text-xs flex gap-4">
                <span className="font-bold">{p.symbol}</span>
                <span>Entry: {p.entry_price}</span>
                <span>Qty: {p.quantity}</span>
                <span className="text-text-secondary">Executor: {p.executor_id}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Trades table */}
      {trades.length > 0 && (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-text-secondary border-b border-border">
              <th className="text-left py-2 px-2">Symbol</th>
              <th className="text-left py-2 px-2">Action</th>
              <th className="text-right py-2 px-2">Entry</th>
              <th className="text-right py-2 px-2">TP</th>
              <th className="text-right py-2 px-2">SL</th>
              <th className="text-right py-2 px-2">Qty</th>
              <th className="text-left py-2 px-2">Reason</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t, i) => (
              <tr key={i} className="border-b border-border/50 hover:bg-card">
                <td className="py-2 px-2 font-medium">{t.symbol}</td>
                <td className="py-2 px-2">
                  <span className={t.action?.includes('BUY') ? 'text-green' : 'text-red'}>{t.action}</span>
                </td>
                <td className="text-right py-2 px-2">{t.entry_price?.toFixed(2)}</td>
                <td className="text-right py-2 px-2">{t.take_profit_price?.toFixed(2)}</td>
                <td className="text-right py-2 px-2">{t.stop_loss_price?.toFixed(2)}</td>
                <td className="text-right py-2 px-2">{t.quantity}</td>
                <td className="py-2 px-2 text-text-secondary truncate max-w-[200px]">{t.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!trades.length && !positions.length && (
        <p className="text-text-secondary text-sm">No trades yet.</p>
      )}
    </div>
  )
}
