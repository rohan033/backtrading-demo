import React, { useState, useEffect, useRef } from 'react'

const API_BASE = '/api'

function StatCard({ label, value, colorClass }) {
  return (
    <div className="bg-card border border-border rounded-md px-3 py-2">
      <div className="text-[8px] uppercase tracking-widest text-text-secondary mb-0.5">{label}</div>
      <div className={`text-[15px] font-bold ${colorClass || ''}`}>{value}</div>
    </div>
  )
}

function StatusBadge({ state }) {
  const colors = {
    watching: 'bg-yellow-500/20 text-yellow-400',
    entry_placed: 'bg-blue-500/20 text-blue-400',
    entry_filled: 'bg-purple-500/20 text-purple-400',
    done: 'bg-gray-500/20 text-gray-400',
    active: 'bg-green/20 text-green',
    stopped: 'bg-red/20 text-red',
    profit_capped: 'bg-green/20 text-green',
  }
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-[9px] font-bold uppercase ${colors[state] || 'bg-card text-text-secondary'}`}>
      {state}
    </span>
  )
}

export default function ManualRobo() {
  // Form state
  const [symbol, setSymbol] = useState('')
  const [token, setToken] = useState('')
  const [exchange, setExchange] = useState('NSE')
  const [longPercent, setLongPercent] = useState(0.5)
  const [shortPercent, setShortPercent] = useState(10)
  const [initThreshold, setInitThreshold] = useState(0.1)
  const [configuredCapital, setConfiguredCapital] = useState(100000)
  const [dailyProfitTarget, setDailyProfitTarget] = useState(1.0)
  const [closingStart, setClosingStart] = useState('')
  const [closingEnd, setClosingEnd] = useState('')

  // Engine state
  const [activeSession, setActiveSession] = useState(null)
  const [engineStatus, setEngineStatus] = useState(null)
  const [orders, setOrders] = useState([])
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // Search
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searchLoading, setSearchLoading] = useState(false)

  // Polling
  const pollRef = useRef(null)

  // Auto-set closing dates
  useEffect(() => {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const y = yesterday.getFullYear()
    const m = String(yesterday.getMonth() + 1).padStart(2, '0')
    const d = String(yesterday.getDate()).padStart(2, '0')
    setClosingStart(`${y}-${m}-${d} 15:29`)
    setClosingEnd(`${y}-${m}-${d} 15:30`)
  }, [])

  // Load sessions on mount
  useEffect(() => {
    fetchSessions()
  }, [])

  // Poll status when session is active
  useEffect(() => {
    if (activeSession) {
      pollStatus()
      pollRef.current = setInterval(pollStatus, 5000)
      return () => clearInterval(pollRef.current)
    }
  }, [activeSession])

  const fetchSessions = async () => {
    try {
      const res = await fetch(`${API_BASE}/robo/sessions`)
      const data = await res.json()
      if (data.status) {
        setSessions(data.data || [])
        const active = (data.data || []).find(s => s.status === 'active')
        if (active) setActiveSession(active.id)
      }
    } catch (e) { console.error(e) }
  }

  const pollStatus = async () => {
    if (!activeSession) return
    try {
      const res = await fetch(`${API_BASE}/robo/status?session_id=${activeSession}`)
      const data = await res.json()
      if (data.status) {
        setEngineStatus(data.data)
        if (data.data.session?.status !== 'active') {
          setActiveSession(null)
          clearInterval(pollRef.current)
          fetchSessions()
        }
      }

      const ordersRes = await fetch(`${API_BASE}/robo/orders?session_id=${activeSession}`)
      const ordersData = await ordersRes.json()
      if (ordersData.status) setOrders(ordersData.data || [])
    } catch (e) { console.error(e) }
  }

  const searchStock = async () => {
    if (!searchQuery.trim()) return
    setSearchLoading(true)
    try {
      const res = await fetch(`${API_BASE}/search?q=${encodeURIComponent(searchQuery)}`)
      const data = await res.json()
      setSearchResults(data.status ? (data.data || []) : [])
    } catch (e) { setSearchResults([]) }
    finally { setSearchLoading(false) }
  }

  const selectStock = (stock) => {
    setSymbol(stock.tradingsymbol)
    setToken(stock.symboltoken)
    setExchange(stock.exchange || 'NSE')
    setSearchResults([])
    setSearchQuery('')
  }

  const startEngine = async () => {
    if (!symbol || !token) {
      setError('Please fill symbol and token')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE}/robo/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol, token, exchange,
          long_percent: longPercent,
          short_percent: shortPercent,
          initial_threshold: initThreshold,
          configured_capital: configuredCapital,
          daily_profit_target_pct: dailyProfitTarget,
          closing_start: closingStart,
          closing_end: closingEnd,
        })
      })
      const data = await res.json()
      if (data.status) {
        setActiveSession(data.session_id)
        setError(null)
      } else {
        setError(data.detail || data.message || 'Failed to start')
      }
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  const stopEngine = async () => {
    if (!activeSession) return
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/robo/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: activeSession })
      })
      const data = await res.json()
      if (data.status) {
        setActiveSession(null)
        setEngineStatus(null)
        clearInterval(pollRef.current)
        fetchSessions()
      }
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  const pnlColor = (v) => v >= 0 ? 'text-green' : 'text-red'

  // If there's an active session, show the dashboard
  if (activeSession && engineStatus) {
    const session = engineStatus.session || {}
    const profitCap = (session.configured_capital || 0) * (session.daily_profit_target_pct || 1) / 100
    const profitProgress = profitCap > 0 ? Math.min(((session.total_pnl || 0) / profitCap) * 100, 100) : 0

    return (
      <div className="flex-1 overflow-auto p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold">ManualRobo</h2>
            <StatusBadge state={engineStatus.state} />
            <span className="text-[11px] text-text-secondary">
              {session.symbol} ({session.token})
            </span>
          </div>
          <button
            onClick={stopEngine}
            disabled={loading}
            className="px-4 py-2 rounded-md font-bold text-xs tracking-wide text-white bg-red hover:opacity-85 transition-opacity disabled:opacity-50"
          >
            Stop Engine
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-6 gap-2 mb-6">
          <StatCard label="Total P&L" value={`₹${(session.total_pnl || 0).toFixed(2)}`} colorClass={pnlColor(session.total_pnl || 0)} />
          <StatCard label="Profit Cap" value={`₹${profitCap.toFixed(0)}`} />
          <StatCard label="Progress" value={`${profitProgress.toFixed(1)}%`} colorClass={profitProgress >= 100 ? 'text-green' : ''} />
          <StatCard label="Capital" value={`₹${(session.configured_capital || 0).toLocaleString()}`} />
          <StatCard label="Quantity" value={session.quantity || 0} />
          <StatCard label="Last LTP"
            value={engineStatus.recent_ltp?.[0] ? `₹${engineStatus.recent_ltp[0].ltp.toFixed(2)}` : '—'} />
        </div>

        {/* Profit Progress Bar */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[9px] uppercase tracking-[1.5px] text-text-secondary">Daily Profit Target ({session.daily_profit_target_pct}%)</span>
            <span className="text-[10px] text-text-secondary">₹{(session.total_pnl || 0).toFixed(2)} / ₹{profitCap.toFixed(0)}</span>
          </div>
          <div className="w-full bg-[#1e2d3d] rounded h-2 overflow-hidden">
            <div
              className={`h-full rounded transition-all duration-500 ${profitProgress >= 100 ? 'bg-green' : 'bg-accent'}`}
              style={{ width: `${Math.max(0, profitProgress)}%` }}
            />
          </div>
        </div>

        {/* Strategy Params */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-card border border-border rounded-md p-3">
            <div className="text-[8px] uppercase tracking-widest text-text-secondary mb-1">Strategy</div>
            <div className="text-[10px] space-y-0.5">
              <div>Initial Threshold: <span className="text-accent">{session.initial_threshold}%</span></div>
              <div>Take Profit: <span className="text-green">{session.long_percent}%</span></div>
              <div>Stop Loss: <span className="text-red">{session.short_percent}%</span></div>
            </div>
          </div>
          <div className="bg-card border border-border rounded-md p-3">
            <div className="text-[8px] uppercase tracking-widest text-text-secondary mb-1">Entry</div>
            <div className="text-[10px] space-y-0.5">
              {engineStatus.filled_price ? (
                <div>Filled at: <span className="text-accent">₹{engineStatus.filled_price.toFixed(2)}</span></div>
              ) : (
                <div className="text-text-secondary">Waiting for entry signal...</div>
              )}
            </div>
          </div>
          <div className="bg-card border border-border rounded-md p-3">
            <div className="text-[8px] uppercase tracking-widest text-text-secondary mb-1">Recent LTP</div>
            <div className="text-[10px] space-y-0.5">
              {(engineStatus.recent_ltp || []).slice(0, 3).map((l, i) => (
                <div key={i} className="flex justify-between">
                  <span className="text-text-secondary">{l.timestamp?.split('T')[1]?.slice(0, 8)}</span>
                  <span>₹{l.ltp.toFixed(2)}</span>
                  <span className={`text-[8px] ${l.strategy_signal === 'buy' ? 'text-green' : l.strategy_signal === 'sell' ? 'text-red' : 'text-text-secondary'}`}>
                    {l.strategy_signal || 'hold'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Orders Table */}
        <div>
          <h3 className="text-[9px] uppercase tracking-[1.5px] text-text-secondary mb-2">Orders</h3>
          <div className="max-h-64 overflow-auto border border-border rounded">
            <table className="w-full border-collapse text-[10px]">
              <thead className="bg-secondary sticky top-0">
                <tr className="text-text-secondary text-[8px] uppercase tracking-wider border-b border-border">
                  <th className="text-left py-2 px-3">Role</th>
                  <th className="text-left py-2 px-3">Type</th>
                  <th className="text-left py-2 px-3">Order Type</th>
                  <th className="text-right py-2 px-3">Price</th>
                  <th className="text-right py-2 px-3">Trigger</th>
                  <th className="text-right py-2 px-3">Qty</th>
                  <th className="text-left py-2 px-3">Status</th>
                  <th className="text-right py-2 px-3">Filled</th>
                  <th className="text-left py-2 px-3">Time</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o, i) => (
                  <tr key={i} className="border-b border-border/30 hover:bg-accent/5">
                    <td className="py-1.5 px-3 font-semibold capitalize">{o.role}</td>
                    <td className="py-1.5 px-3">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[8px] font-bold ${
                        o.transaction_type === 'BUY' ? 'bg-green/15 text-green' : 'bg-red/15 text-red'
                      }`}>{o.transaction_type}</span>
                    </td>
                    <td className="py-1.5 px-3 text-text-secondary">{o.order_type}</td>
                    <td className="py-1.5 px-3 text-right">{o.price ? `₹${o.price.toFixed(2)}` : '—'}</td>
                    <td className="py-1.5 px-3 text-right">{o.trigger_price ? `₹${o.trigger_price.toFixed(2)}` : '—'}</td>
                    <td className="py-1.5 px-3 text-right">{o.quantity}</td>
                    <td className="py-1.5 px-3"><StatusBadge state={o.status} /></td>
                    <td className="py-1.5 px-3 text-right">{o.filled_price ? `₹${o.filled_price.toFixed(2)}` : '—'}</td>
                    <td className="py-1.5 px-3 text-text-secondary">{o.placed_at?.split('T')[1]?.slice(0, 8)}</td>
                  </tr>
                ))}
                {orders.length === 0 && (
                  <tr><td colSpan={9} className="py-4 text-center text-text-secondary">No orders yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    )
  }

  // Configuration / Start view
  return (
    <div className="flex-1 overflow-auto p-6">
      <h2 className="text-sm font-semibold mb-6">ManualRobo — Live Trading Engine</h2>

      {error && (
        <div className="bg-red/10 border border-red/30 text-red text-xs px-4 py-2 rounded mb-4">{error}</div>
      )}

      <div className="grid grid-cols-3 gap-6 max-w-4xl">
        {/* Symbol Selection */}
        <div>
          <h3 className="text-[9px] uppercase tracking-[1.5px] text-text-secondary mb-3">Symbol</h3>
          <div className="space-y-2">
            <div className="relative">
              <div className="flex gap-1">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && searchStock()}
                  placeholder="Search stock..."
                  className="flex-1 px-2 py-1.5 bg-primary border border-border rounded text-[11px] outline-none focus:border-accent"
                />
                <button onClick={searchStock} disabled={searchLoading}
                  className="px-2 py-1.5 bg-accent/20 text-accent rounded text-[9px] font-bold hover:bg-accent/30">
                  {searchLoading ? '...' : 'Go'}
                </button>
              </div>
              {searchResults.length > 0 && (
                <div className="absolute mt-1 w-full border border-border rounded max-h-32 overflow-auto bg-card z-10">
                  {searchResults.map(stock => (
                    <button key={stock.symboltoken} onClick={() => selectStock(stock)}
                      className="w-full text-left px-3 py-1.5 text-[10px] hover:bg-accent/5 border-b border-border/30 last:border-0">
                      <div className="font-medium">{stock.tradingsymbol}</div>
                      <div className="text-text-secondary text-[9px]">{stock.exchange} - {stock.symboltoken}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <label className="block text-[10px] text-text-secondary mb-1">Symbol</label>
              <input value={symbol} onChange={e => setSymbol(e.target.value)}
                className="w-full px-2 py-1.5 bg-primary border border-border rounded text-[11px] outline-none focus:border-accent"
                placeholder="e.g. SBIN-EQ" />
            </div>
            <div>
              <label className="block text-[10px] text-text-secondary mb-1">Token</label>
              <input value={token} onChange={e => setToken(e.target.value)}
                className="w-full px-2 py-1.5 bg-primary border border-border rounded text-[11px] outline-none focus:border-accent"
                placeholder="e.g. 3045" />
            </div>
            <div>
              <label className="block text-[10px] text-text-secondary mb-1">Exchange</label>
              <select value={exchange} onChange={e => setExchange(e.target.value)}
                className="w-full px-2 py-1.5 bg-primary border border-border rounded text-[11px] outline-none focus:border-accent">
                <option value="NSE">NSE</option>
                <option value="BSE">BSE</option>
              </select>
            </div>
          </div>
        </div>

        {/* Strategy */}
        <div>
          <h3 className="text-[9px] uppercase tracking-[1.5px] text-text-secondary mb-3">Strategy Parameters</h3>
          <div className="space-y-2">
            <div>
              <label className="block text-[10px] text-text-secondary mb-1">Initial Threshold (%)</label>
              <input type="number" value={initThreshold} onChange={e => setInitThreshold(+e.target.value)} step={0.01}
                className="w-full px-2 py-1.5 bg-primary border border-border rounded text-[11px] outline-none focus:border-accent" />
            </div>
            <div>
              <label className="block text-[10px] text-text-secondary mb-1">Take Profit — Long (%)</label>
              <input type="number" value={longPercent} onChange={e => setLongPercent(+e.target.value)} step={0.1}
                className="w-full px-2 py-1.5 bg-primary border border-border rounded text-[11px] outline-none focus:border-accent" />
            </div>
            <div>
              <label className="block text-[10px] text-text-secondary mb-1">Stop Loss — Short (%)</label>
              <input type="number" value={shortPercent} onChange={e => setShortPercent(+e.target.value)} step={0.5}
                className="w-full px-2 py-1.5 bg-primary border border-border rounded text-[11px] outline-none focus:border-accent" />
            </div>
            <div>
              <label className="block text-[10px] text-text-secondary mb-1">Prev Close Start</label>
              <input value={closingStart} onChange={e => setClosingStart(e.target.value)}
                className="w-full px-2 py-1.5 bg-primary border border-border rounded text-[11px] outline-none focus:border-accent"
                placeholder="2026-05-14 15:29" />
            </div>
            <div>
              <label className="block text-[10px] text-text-secondary mb-1">Prev Close End</label>
              <input value={closingEnd} onChange={e => setClosingEnd(e.target.value)}
                className="w-full px-2 py-1.5 bg-primary border border-border rounded text-[11px] outline-none focus:border-accent"
                placeholder="2026-05-14 15:30" />
            </div>
          </div>
        </div>

        {/* Capital */}
        <div>
          <h3 className="text-[9px] uppercase tracking-[1.5px] text-text-secondary mb-3">Capital & Limits</h3>
          <div className="space-y-2">
            <div>
              <label className="block text-[10px] text-text-secondary mb-1">Configured Capital (₹)</label>
              <input type="number" value={configuredCapital} onChange={e => setConfiguredCapital(+e.target.value)} step={1000}
                className="w-full px-2 py-1.5 bg-primary border border-border rounded text-[11px] outline-none focus:border-accent" />
            </div>
            <div>
              <label className="block text-[10px] text-text-secondary mb-1">Daily Profit Target (%)</label>
              <input type="number" value={dailyProfitTarget} onChange={e => setDailyProfitTarget(+e.target.value)} step={0.1}
                className="w-full px-2 py-1.5 bg-primary border border-border rounded text-[11px] outline-none focus:border-accent" />
            </div>
          </div>

          <div className="mt-6">
            <button
              onClick={startEngine}
              disabled={loading || !symbol || !token}
              className="w-full px-6 py-2.5 rounded-md font-bold text-xs tracking-wide text-white bg-green hover:opacity-85 transition-opacity disabled:opacity-50"
            >
              {loading ? 'Starting...' : 'Start ManualRobo'}
            </button>
          </div>
        </div>
      </div>

      {/* Previous Sessions */}
      {sessions.length > 0 && (
        <div className="mt-8 max-w-4xl">
          <h3 className="text-[9px] uppercase tracking-[1.5px] text-text-secondary mb-2">Today's Sessions</h3>
          <div className="border border-border rounded overflow-hidden">
            <table className="w-full border-collapse text-[10px]">
              <thead className="bg-secondary">
                <tr className="text-text-secondary text-[8px] uppercase tracking-wider border-b border-border">
                  <th className="text-left py-2 px-3">ID</th>
                  <th className="text-left py-2 px-3">Symbol</th>
                  <th className="text-right py-2 px-3">Qty</th>
                  <th className="text-right py-2 px-3">P&L</th>
                  <th className="text-left py-2 px-3">Status</th>
                  <th className="text-left py-2 px-3">Started</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map(s => (
                  <tr key={s.id} className="border-b border-border/30 hover:bg-accent/5">
                    <td className="py-1.5 px-3">{s.id}</td>
                    <td className="py-1.5 px-3 font-semibold">{s.symbol}</td>
                    <td className="py-1.5 px-3 text-right">{s.quantity}</td>
                    <td className={`py-1.5 px-3 text-right ${pnlColor(s.total_pnl || 0)}`}>₹{(s.total_pnl || 0).toFixed(2)}</td>
                    <td className="py-1.5 px-3"><StatusBadge state={s.status} /></td>
                    <td className="py-1.5 px-3 text-text-secondary">{s.started_at?.split('T')[1]?.slice(0, 8)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
