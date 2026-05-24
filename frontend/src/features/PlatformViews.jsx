import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { createChart } from 'lightweight-charts'

import { formatInr, formatIndianNumber, formatSignedInr } from '../lib/currency'

const API_BASE = '/api'
const WS_BASE = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`

// ── Stat Card ──
function StatCard({ label, value, colorClass }) {
  return (
    <div className="bg-card border border-border rounded-md px-3 py-2">
      <div className="text-[8px] uppercase tracking-widest text-text-secondary mb-0.5">{label}</div>
      <div className={`text-[15px] font-bold ${colorClass || ''}`}>{value}</div>
    </div>
  )
}

// ── Toast ──
function Toast({ order }) {
  const isBuy = order.type === 'BUY'
  const icon = isBuy ? '▲' : '▼'
  const pnlBit = !isBuy ? ` P&L: ${formatInr(order.pnl)}` : ''
  return (
    <div className={`toast-enter px-4 py-2.5 rounded-lg text-xs font-semibold shadow-lg flex items-center gap-2 text-white ${isBuy ? 'bg-green/90' : 'bg-red/90'}`}>
      <span className="text-lg">{icon}</span>
      {order.type} {order.qty} @ {formatInr(order.price)}{pnlBit}
    </div>
  )
}

export default function PlatformViews({ mode = 'portfolio' }) {
  const location = useLocation()
  // ── State ──
  const [portfolio, setPortfolio] = useState([])
  const [portfolioLoading, setPortfolioLoading] = useState(true)
  const [portfolioError, setPortfolioError] = useState(null)
  const [selected, setSelected] = useState(null)
  const [view, setView] = useState('portfolio') // 'portfolio' | 'backtest' | 'compound'

  // Portfolio sorting state
  const [portfolioSort, setPortfolioSort] = useState({ column: 'tradingsymbol', direction: 'asc' })

  // Compound calculator state
  const [compoundInitial, setCompoundInitial] = useState(100000)
  const [compoundDays, setCompoundDays] = useState(30)
  const [compoundPercentage, setCompoundPercentage] = useState(1)
  const [compoundResults, setCompoundResults] = useState(null)

  // Search state
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchedStock, setSearchedStock] = useState(null)

  // Backtest form - auto-set to today's date
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  
  const formatDate = (date, time) => {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day} ${time}`
  }

  // Portfolio sorting function
  const handleSort = (column) => {
    setPortfolioSort(prev => ({
      column,
      direction: prev.column === column && prev.direction === 'asc' ? 'desc' : 'asc'
    }))
  }

  // Search function
  const searchStock = async () => {
    if (!searchQuery.trim()) return
    
    setSearchLoading(true)
    try {
      const response = await fetch(`${API_BASE}/search?q=${encodeURIComponent(searchQuery)}`)
      const data = await response.json()
      
      if (data.status) {
        setSearchResults(data.data || [])
      } else {
        setSearchResults([])
      }
    } catch (error) {
      console.error('Search error:', error)
      setSearchResults([])
    } finally {
      setSearchLoading(false)
    }
  }

  // Select searched stock
  const selectSearchedStock = (stock) => {
    setSearchedStock(stock)
    setSelected({
      symboltoken: stock.symboltoken,
      tradingsymbol: stock.tradingsymbol,
      exchange: stock.exchange,
      ltp: 0 // Will be updated when backtest runs
    })
    setSearchResults([])
    setSearchQuery('')
  }

  // Date preset functions
  const applyDatePreset = (preset) => {
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    const dayBefore = new Date(today)
    dayBefore.setDate(dayBefore.getDate() - 2)
    
    if (preset === 'today') {
      setStartDate(formatDate(today, '09:15'))
      setEndDate(formatDate(today, '15:15'))
      setClosingStart(formatDate(yesterday, '15:29'))
      setClosingEnd(formatDate(yesterday, '15:30'))
    } else if (preset === 'yesterday') {
      setStartDate(formatDate(yesterday, '09:15'))
      setEndDate(formatDate(yesterday, '15:15'))
      setClosingStart(formatDate(dayBefore, '15:29'))
      setClosingEnd(formatDate(dayBefore, '15:30'))
    }
  }

  // Compound calculator function
  const calculateCompound = () => {
    const dailyReturn = compoundPercentage / 100 // Convert percentage to decimal
    const results = []
    let currentAmount = compoundInitial
    let cumulativeProfit = 0
    
    for (let day = 1; day <= compoundDays; day++) {
      const dailyProfit = currentAmount * dailyReturn
      const dayEndAmount = currentAmount + dailyProfit
      cumulativeProfit += dailyProfit
      
      results.push({
        day,
        investment: currentAmount,
        profitPercentage: compoundPercentage,
        dailyProfit,
        netProfitTillNow: cumulativeProfit,
        finalAmount: dayEndAmount
      })
      
      currentAmount = dayEndAmount
    }
    
    const totalProfit = currentAmount - compoundInitial
    const totalReturnPercentage = ((currentAmount / compoundInitial - 1) * 100)
    
    setCompoundResults({
      dailyData: results,
      summary: {
        initialInvestment: compoundInitial,
        finalAmount: currentAmount,
        totalProfit,
        totalReturnPercentage,
        days: compoundDays
      }
    })
  }

  const getSortedPortfolio = () => {
    if (!portfolio.length) return []
    
    return [...portfolio].sort((a, b) => {
      let aVal = a[portfolioSort.column]
      let bVal = b[portfolioSort.column]
      
      // Handle numeric columns
      if (portfolioSort.column === 'quantity' || portfolioSort.column === 'ltp') {
        aVal = parseFloat(aVal) || 0
        bVal = parseFloat(bVal) || 0
      }
      
      if (portfolioSort.direction === 'asc') {
        return aVal > bVal ? 1 : aVal < bVal ? -1 : 0
      } else {
        return aVal < bVal ? 1 : aVal > bVal ? -1 : 0
      }
    })
  }
  
  const [startDate, setStartDate] = useState(formatDate(today, '09:15'))
  const [endDate, setEndDate] = useState(formatDate(today, '15:15'))
  const [closingStart, setClosingStart] = useState(formatDate(yesterday, '15:29'))
  const [closingEnd, setClosingEnd] = useState(formatDate(yesterday, '15:30'))
  const [longPercent, setLongPercent] = useState(0.5)
  const [shortPercent, setShortPercent] = useState(10)
  const [initThreshold, setInitThreshold] = useState(0.1)
  const [funds, setFunds] = useState(110000)
  const [baseFunds, setBaseFunds] = useState(100000)

  // Backtest results
  const [streaming, setStreaming] = useState(false)
  const [totalCandles, setTotalCandles] = useState(0)
  const [backtestLoading, setBacktestLoading] = useState(false)
  const [backtestError, setBacktestError] = useState(null)
  const [backtestDone, setBacktestDone] = useState(false)

  // Animation state
  const [playing, setPlaying] = useState(false)
  const [currentIdx, setCurrentIdx] = useState(0)
  const [speed, setSpeed] = useState(200) // ms between candles (server-side)
  const [displayedOrders, setDisplayedOrders] = useState([])
  const [stats, setStats] = useState({ netPnl: 0, returnPct: 0, totalTrades: 0, wins: 0, winRate: 0, shares: 0, funds: 0, totalFees: 0 })
  const [toasts, setToasts] = useState([])

  // Refs
  const chartContainerRef = useRef(null)
  const chartRef = useRef(null)
  const candleSeriesRef = useRef(null)
  const equitySeriesRef = useRef(null)
  const displayedCandlesRef = useRef([])
  const markersRef = useRef([])
  const equityDataRef = useRef([])
  const orderLogRef = useRef(null)
  const toastIdRef = useRef(0)
  const wsRef = useRef(null)
  const startFundsRef = useRef(0)
  const equityRef = useRef(0)
  const tpLineRef = useRef(null)
  const slLineRef = useRef(null)
  const buyLineRef = useRef(null)

  // ── Fetch portfolio on mount ──
  useEffect(() => {
    fetch(`${API_BASE}/portfolio`)
      .then(r => r.json())
      .then(data => {
        if (data.status) setPortfolio(data.data || [])
        else setPortfolioError('Failed to load portfolio')
      })
      .catch(e => setPortfolioError(e.message))
      .finally(() => setPortfolioLoading(false))
  }, [])

  useEffect(() => {
    if (location.state?.stock && mode === 'backtest') {
      setSelected(location.state.stock)
    }
  }, [location.state, mode])

  // ── Chart setup ──
  const createChartInstance = useCallback(() => {
    const el = chartContainerRef.current
    if (!el) return
    if (chartRef.current) { chartRef.current.remove(); chartRef.current = null }

    const w = el.clientWidth || 800
    const h = el.clientHeight || 400
    const chart = createChart(el, {
      width: w, height: h,
      layout: { background: { color: '#0f1923' }, textColor: '#8899a6' },
      grid: { vertLines: { color: '#1a2733' }, horzLines: { color: '#1a2733' } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#2a3f52' },
      rightPriceScale: { borderColor: '#2a3f52' },
    })

    const cs = chart.addCandlestickSeries({
      upColor: '#00c853', downColor: '#ff1744',
      borderUpColor: '#00c853', borderDownColor: '#ff1744',
      wickUpColor: '#00c853', wickDownColor: '#ff1744',
    })
    const es = chart.addLineSeries({
      color: 'rgba(29,161,242,0.5)', lineWidth: 1,
      priceScaleId: 'equity', lastValueVisible: false, priceLineVisible: false,
    })
    chart.priceScale('equity').applyOptions({ scaleMargins: { top: 0.7, bottom: 0 }, visible: false })

    chartRef.current = chart
    candleSeriesRef.current = cs
    equitySeriesRef.current = es

    const ro = new ResizeObserver(() => { chart.resize(el.clientWidth, el.clientHeight) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ── Render a single tick from the server ──
  const renderTick = useCallback((candle, order, serverStats, levels) => {
    const cs = candleSeriesRef.current
    const es = equitySeriesRef.current
    if (!cs || !es) return

    // Deduplicate by time
    const lastDisplayed = displayedCandlesRef.current[displayedCandlesRef.current.length - 1]
    if (lastDisplayed && lastDisplayed.time === candle.time) return

    displayedCandlesRef.current.push({
      time: candle.time, open: candle.open, high: candle.high, low: candle.low, close: candle.close,
    })
    cs.setData([...displayedCandlesRef.current])

    // Equity curve — track it based on server P&L
    equityRef.current = startFundsRef.current + serverStats.netPnl
    equityDataRef.current.push({ time: candle.time, value: equityRef.current })
    es.setData([...equityDataRef.current])

    if (order) {
      markersRef.current.push({
        time: order.time || candle.time,
        position: order.type === 'BUY' ? 'belowBar' : 'aboveBar',
        color: order.type === 'BUY' ? '#00c853' : '#ff1744',
        shape: order.type === 'BUY' ? 'arrowUp' : 'arrowDown',
        text: `${order.type} ${formatInr(order.price)}`,
      })
      cs.setMarkers([...markersRef.current])

      setDisplayedOrders(prev => [...prev, order])

      const tid = ++toastIdRef.current
      setToasts(prev => [...prev, { ...order, id: tid }])
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== tid)), 2400)
    }

    // Update strategy price lines
    if (levels) {
      // TP line
      if (levels.tp != null) {
        if (tpLineRef.current) { cs.removePriceLine(tpLineRef.current) }
        tpLineRef.current = cs.createPriceLine({
          price: levels.tp, color: '#00c853', lineWidth: 1,
          lineStyle: 2, axisLabelVisible: true, title: `TP ${formatInr(levels.tp)}`,
        })
      } else if (tpLineRef.current) {
        cs.removePriceLine(tpLineRef.current)
        tpLineRef.current = null
      }

      // SL line
      if (levels.sl != null) {
        if (slLineRef.current) { cs.removePriceLine(slLineRef.current) }
        slLineRef.current = cs.createPriceLine({
          price: levels.sl, color: '#ff1744', lineWidth: 1,
          lineStyle: 2, axisLabelVisible: true, title: `SL ${formatInr(levels.sl)}`,
        })
      } else if (slLineRef.current) {
        cs.removePriceLine(slLineRef.current)
        slLineRef.current = null
      }

      // Buy trigger line
      if (levels.buyTrigger != null) {
        if (buyLineRef.current) { cs.removePriceLine(buyLineRef.current) }
        buyLineRef.current = cs.createPriceLine({
          price: levels.buyTrigger, color: '#1da1f2', lineWidth: 1,
          lineStyle: 2, axisLabelVisible: true, title: `BUY ${formatInr(levels.buyTrigger)}`,
        })
      } else if (buyLineRef.current) {
        cs.removePriceLine(buyLineRef.current)
        buyLineRef.current = null
      }
    }

    const oc = serverStats.orderCount || 0
    setStats({
      netPnl: serverStats.netPnl,
      returnPct: startFundsRef.current > 0 ? ((serverStats.netPnl / startFundsRef.current) * 100) : 0,
      totalTrades: oc,
      wins: 0,
      winRate: 0,
      shares: serverStats.totalShares || 0,
      funds: serverStats.fundsRemaining || 0,
      totalFees: serverStats.totalFees || 0,
    })

    chartRef.current?.timeScale().scrollToPosition(2, false)
  }, [])

  // ── Send command to server ──
  const wsSend = useCallback((obj) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(obj))
    }
  }, [])

  // ── Toggle pause / resume ──
  const togglePlay = useCallback(() => {
    if (playing) {
      wsSend({ action: 'pause' })
      setPlaying(false)
    } else {
      wsSend({ action: 'resume' })
      setPlaying(true)
    }
  }, [playing, wsSend])

  // ── Change speed (tell server) ──
  const changeSpeed = useCallback((newSpeed) => {
    setSpeed(newSpeed)
    wsSend({ action: 'speed', speed_ms: newSpeed })
  }, [wsSend])

  // ── Stop stream ──
  const stopStream = useCallback(() => {
    wsSend({ action: 'stop' })
    setPlaying(false)
    setStreaming(false)
  }, [wsSend])

  // ── Run backtest via WebSocket ──
  const runBacktest = () => {
    if (!selected) return

    // Close any existing socket
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }

    // Destroy old chart so a fresh one is created
    if (chartRef.current) {
      chartRef.current.remove()
      chartRef.current = null
      candleSeriesRef.current = null
      equitySeriesRef.current = null
    }

    // Reset chart state
    setBacktestLoading(true)
    setBacktestError(null)
    setBacktestDone(false)
    setStreaming(false)
    setCurrentIdx(0)
    setDisplayedOrders([])
    setTotalCandles(0)
    displayedCandlesRef.current = []
    markersRef.current = []
    equityDataRef.current = []
    startFundsRef.current = funds
    equityRef.current = funds
    tpLineRef.current = null
    slLineRef.current = null
    buyLineRef.current = null
    setStats({ netPnl: 0, returnPct: 0, totalTrades: 0, wins: 0, winRate: 0, shares: 0, funds: funds, totalFees: 0 })

    const ws = new WebSocket(`${WS_BASE}/ws/backtest`)
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({
        token: selected.symboltoken,
        symbol: selected.tradingsymbol,
        start_date: startDate,
        end_date: endDate,
        closing_start: closingStart,
        closing_end: closingEnd,
        long_percent: longPercent,
        short_percent: shortPercent,
        initial_threshold: initThreshold,
        funds,
        base_funds: baseFunds,
        speed_ms: speed,
      }))
    }

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data)

      if (msg.type === 'init') {
        setTotalCandles(msg.totalCandles)
        setBacktestLoading(false)
        setStreaming(true)
        setPlaying(true)
      } else if (msg.type === 'tick') {
        setCurrentIdx(msg.index + 1)
        renderTick(msg.candle, msg.order, msg.stats, msg.levels)
      } else if (msg.type === 'done') {
        setPlaying(false)
        setStreaming(false)
        setBacktestDone(true)
        const s = msg.stats
        setStats({
          netPnl: s.netPnl,
          returnPct: s.returnPct,
          totalTrades: s.totalTrades,
          wins: s.wins,
          winRate: s.winRate,
          shares: 0,
          funds: s.fundsRemaining,
          totalFees: s.totalFees || 0,
        })
      } else if (msg.type === 'error') {
        setBacktestError(msg.message)
        setBacktestLoading(false)
        setStreaming(false)
      }
    }

    ws.onerror = () => {
      setBacktestError('WebSocket connection failed')
      setBacktestLoading(false)
      setStreaming(false)
    }

    ws.onclose = () => {
      setStreaming(false)
    }
  }

  // ── Create chart once the container is in the DOM ──
  useEffect(() => {
    if (streaming && chartContainerRef.current && !chartRef.current) {
      createChartInstance()
    }
  }, [streaming, createChartInstance])

  // ── Cleanup WS on unmount ──
  useEffect(() => {
    return () => { if (wsRef.current) wsRef.current.close() }
  }, [])

  // ── Preset strategies ──
  const applyPreset = (name) => {
    const presets = {
      scalper: { init: 0.05, long: 0.2, short: 0.3 },
      conservative: { init: 0.3, long: 1.0, short: 5.0 },
      aggressive: { init: 0.05, long: 0.3, short: 15.0 },
      tight: { init: 0.1, long: 0.5, short: 1.0 },
    }
    const p = presets[name]
    if (!p) return
    setInitThreshold(p.init)
    setLongPercent(p.long)
    setShortPercent(p.short)
  }

  const pnlColor = (v) => v >= 0 ? 'text-green' : 'text-red'

  // ── Scroll order log ──
  useEffect(() => {
    if (orderLogRef.current) {
      orderLogRef.current.scrollTop = orderLogRef.current.scrollHeight
    }
  }, [displayedOrders])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-1 overflow-hidden">
        {(mode === 'portfolio' || mode === 'backtest') && (
        <aside className="w-[300px] bg-secondary border-r border-border flex flex-col shrink-0 overflow-hidden">
          {/* Portfolio Section */}
          <div className="p-4 flex-1 overflow-y-auto">
            <h2 className="text-[9px] uppercase tracking-[1.5px] text-text-secondary mb-3">Portfolio Holdings</h2>

            {portfolioLoading && <p className="text-xs text-text-secondary">Loading portfolio...</p>}
            {portfolioError && <p className="text-xs text-red">{portfolioError}</p>}

            <div className="space-y-0.5">
              {[...portfolio].sort((a, b) => a.tradingsymbol.localeCompare(b.tradingsymbol)).map((item) => {
                const isSelected = selected?.symboltoken === item.symboltoken
                return (
                  <button
                    key={item.symboltoken}
                    onClick={() => { setSelected(item) }}
                    className={`w-full text-left px-3 py-1.5 rounded border text-[11px] font-semibold transition-all ${
                      isSelected
                        ? 'bg-accent/10 border-accent text-accent'
                        : 'bg-card border-border hover:border-accent/50'
                    }`}
                  >
                    {item.tradingsymbol}
                  </button>
                )
              })}
            </div>
          </div>
        </aside>
        )}

        <div className="flex-1 flex flex-col overflow-hidden">
          {mode === 'compound' ? (
            /* Compound Calculator View */
            <div className="flex-1 overflow-auto p-6">
              <h2 className="text-sm font-semibold mb-6">Compound Investment Calculator ({compoundPercentage}% Daily)</h2>
              
              <div className="max-w-4xl">
                {/* Input Section */}
                <div className="grid grid-cols-3 gap-6 mb-8">
                  <div>
                    <label className="text-[9px] uppercase tracking-[1.5px] text-text-secondary block mb-2">Initial Investment (₹)</label>
                    <input
                      type="number"
                      value={compoundInitial}
                      onChange={(e) => setCompoundInitial(Number(e.target.value))}
                      className="w-full px-3 py-2 bg-card border border-border rounded text-[11px] font-medium focus:outline-none focus:border-accent"
                      min="1000"
                      step="1000"
                    />
                  </div>
                  <div>
                    <label className="text-[9px] uppercase tracking-[1.5px] text-text-secondary block mb-2">Daily Profit (%)</label>
                    <input
                      type="number"
                      value={compoundPercentage}
                      onChange={(e) => setCompoundPercentage(Number(e.target.value))}
                      className="w-full px-3 py-2 bg-card border border-border rounded text-[11px] font-medium focus:outline-none focus:border-accent"
                      min="0.1"
                      max="10"
                      step="0.1"
                    />
                  </div>
                  <div>
                    <label className="text-[9px] uppercase tracking-[1.5px] text-text-secondary block mb-2">Trading Days</label>
                    <input
                      type="number"
                      value={compoundDays}
                      onChange={(e) => setCompoundDays(Number(e.target.value))}
                      className="w-full px-3 py-2 bg-card border border-border rounded text-[11px] font-medium focus:outline-none focus:border-accent"
                      min="1"
                      max="365"
                    />
                  </div>
                </div>

                <button
                  onClick={calculateCompound}
                  className="mb-8 px-6 py-2.5 rounded-md font-bold text-xs tracking-wide text-white bg-green hover:opacity-85 transition-opacity"
                >
                  Calculate Compound Returns
                </button>

                {compoundResults && (
                  <>
                    {/* Summary Section */}
                    <div className="grid grid-cols-4 gap-4 mb-8">
                      <StatCard label="Initial Investment" value={formatInr(compoundResults.summary.initialInvestment, { maxFractionDigits: 0 })} />
                      <StatCard label="Final Amount" value={formatInr(compoundResults.summary.finalAmount, { maxFractionDigits: 0 })} colorClass="text-green" />
                      <StatCard label="Total Profit" value={formatInr(compoundResults.summary.totalProfit, { maxFractionDigits: 0 })} colorClass="text-green" />
                      <StatCard label="Total Return %" value={`${compoundResults.summary.totalReturnPercentage.toFixed(2)}%`} colorClass="text-green" />
                    </div>

                    {/* Daily Breakdown Table */}
                    <div>
                      <h3 className="text-[11px] uppercase tracking-[1.5px] text-text-secondary mb-3">Daily Breakdown</h3>
                      <div className="max-h-96 overflow-auto border border-border rounded">
                        <table className="w-full border-collapse text-[10px]">
                          <thead className="bg-secondary sticky top-0">
                            <tr className="text-text-secondary text-[8px] uppercase tracking-wider border-b border-border">
                              <th className="text-left py-2 px-3">Day</th>
                              <th className="text-right py-2 px-3">Investment</th>
                              <th className="text-right py-2 px-3">Profit %</th>
                              <th className="text-right py-2 px-3">Daily Profit</th>
                              <th className="text-right py-2 px-3">Net Profit Till Now</th>
                              <th className="text-right py-2 px-3">Final Amount</th>
                            </tr>
                          </thead>
                          <tbody>
                            {compoundResults.dailyData.map((row) => (
                              <tr key={row.day} className="border-b border-border/30 hover:bg-accent/5 transition-colors">
                                <td className="py-1.5 px-3 font-semibold">{row.day}</td>
                                <td className="py-1.5 px-3 text-right">{formatInr(row.investment)}</td>
                                <td className="py-1.5 px-3 text-right text-green">{row.profitPercentage}%</td>
                                <td className="py-1.5 px-3 text-right text-green">{formatInr(row.dailyProfit)}</td>
                                <td className="py-1.5 px-3 text-right text-green font-semibold">{formatInr(row.netProfitTillNow)}</td>
                                <td className="py-1.5 px-3 text-right font-semibold">{formatInr(row.finalAmount)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          ) : mode === 'portfolio' ? (
            /* Portfolio Table View */
            <div className="flex-1 overflow-auto p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-semibold">Portfolio Overview</h2>
                
                {/* Search Section */}
                <div className="w-80">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && searchStock()}
                      placeholder="Search stock (e.g., SBIN, RELIANCE)"
                      className="flex-1 px-3 py-1.5 bg-card border border-white rounded text-[11px] font-medium focus:outline-none focus:border-accent"
                    />
                    <button
                      onClick={searchStock}
                      disabled={searchLoading || !searchQuery.trim()}
                      className="px-3 py-1.5 bg-accent/20 text-accent rounded text-[10px] font-bold hover:bg-accent/30 transition-colors disabled:opacity-50"
                    >
                      {searchLoading ? '...' : 'Search'}
                    </button>
                  </div>
                  
                  {/* Search Results */}
                  {searchResults.length > 0 && (
                    <div className="absolute mt-1 w-76 border border-white rounded max-h-32 overflow-auto bg-card z-10">
                      {searchResults.map(stock => (
                        <button
                          key={stock.symboltoken}
                          onClick={() => selectSearchedStock(stock)}
                          className="w-full text-left px-3 py-1.5 text-[10px] hover:bg-accent/5 transition-colors border-b border-white/30 last:border-b-0"
                        >
                          <div className="font-medium">{stock.tradingsymbol}</div>
                          <div className="text-text-secondary text-[9px]">{stock.exchange} • Token: {stock.symboltoken}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              
              {portfolioLoading ? (
                <p className="text-text-secondary text-xs">Loading...</p>
              ) : (
                <table className="w-full border-collapse text-[11px]">
                  <thead>
                    <tr className="text-text-secondary text-[8px] uppercase tracking-wider border-b border-border">
                      <th className="text-left py-2 px-3 cursor-pointer hover:text-text-primary" onClick={() => handleSort('tradingsymbol')}>
                        Symbol {portfolioSort.column === 'tradingsymbol' && (portfolioSort.direction === 'asc' ? '▲' : '▼')}
                      </th>
                      <th className="text-left py-2 px-3 cursor-pointer hover:text-text-primary" onClick={() => handleSort('exchange')}>
                        Exchange {portfolioSort.column === 'exchange' && (portfolioSort.direction === 'asc' ? '▲' : '▼')}
                      </th>
                      <th className="text-right py-2 px-3 cursor-pointer hover:text-text-primary" onClick={() => handleSort('quantity')}>
                        Qty {portfolioSort.column === 'quantity' && (portfolioSort.direction === 'asc' ? '▲' : '▼')}
                      </th>
                      <th className="text-right py-2 px-3 cursor-pointer hover:text-text-primary" onClick={() => handleSort('ltp')}>
                        LTP {portfolioSort.column === 'ltp' && (portfolioSort.direction === 'asc' ? '▲' : '▼')}
                      </th>
                      <th className="text-center py-2 px-3">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {getSortedPortfolio().map((item) => (
                      <tr key={item.symboltoken} className="border-b border-border/30 hover:bg-accent/5 transition-colors">
                        <td className="py-2 px-3 font-semibold">{item.tradingsymbol}</td>
                        <td className="py-2 px-3 text-text-secondary">{item.exchange}</td>
                        <td className="py-2 px-3 text-right">{item.quantity}</td>
                        <td className="py-2 px-3 text-right">{formatInr(Number(item.ltp))}</td>
                        <td className="py-2 px-3 text-center">
                          <Link
                            to="/learn/backtest"
                            state={{ stock: item }}
                            className="px-3 py-1 bg-accent/20 text-accent rounded text-[9px] font-bold hover:bg-accent/30 transition-colors"
                          >
                            Backtest
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ) : !streaming && !backtestDone && !backtestLoading ? (
            /* Backtest Config View — shown when stock is selected but no data yet */
            <div className="flex-1 overflow-auto p-6">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-sm font-semibold mb-2">Configure Backtest</h2>
                  {selected ? (
                    <div className="flex items-center gap-3">
                      <span className="text-accent text-xs">Selected: {selected.tradingsymbol}</span>
                      <button
                        onClick={() => { setSelected(null); setSearchedStock(null) }}
                        className="text-[9px] text-text-secondary hover:text-text-primary transition-colors"
                      >
                        ✕ Change
                      </button>
                    </div>
                  ) : (
                    <div className="mb-3">
                      <label className="text-[9px] uppercase tracking-[1.5px] text-text-secondary block mb-1">Select Stock</label>
                      <select
                        value={selected?.symboltoken || ''}
                        onChange={(e) => {
                          const stock = portfolio.find(item => item.symboltoken === e.target.value)
                          setSelected(stock || null)
                          setSearchedStock(null)
                        }}
                        className="w-full px-3 py-1.5 bg-card border border-white rounded text-[11px] font-medium focus:outline-none focus:border-accent"
                      >
                        <option value="">Choose a stock...</option>
                        {[...portfolio].sort((a, b) => a.tradingsymbol.localeCompare(b.tradingsymbol)).map(item => (
                          <option key={item.symboltoken} value={item.symboltoken}>
                            {item.tradingsymbol} — {formatInr(Number(item.ltp))}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
                <Link to="/portfolio"
                  className="text-[10px] text-text-secondary hover:text-text-primary transition-colors">
                  ← Portfolio
                </Link>
              </div>

              {backtestError && (
                <div className="bg-red/10 border border-red/30 text-red text-xs px-4 py-2 rounded mb-4">{backtestError}</div>
              )}

              <div className="grid grid-cols-3 gap-6 max-w-3xl">
                {/* Date Range */}
                <div>
                  <h3 className="text-[9px] uppercase tracking-[1.5px] text-text-secondary mb-3">Date Range</h3>
                  <div className="flex gap-2 mb-3">
                    <button
                      onClick={() => applyDatePreset('yesterday')}
                      className="px-3 py-1 bg-card border border-border rounded text-[9px] text-text-secondary hover:border-accent hover:text-text-primary transition-colors"
                    >
                      Yesterday
                    </button>
                    <button
                      onClick={() => applyDatePreset('today')}
                      className="px-3 py-1 bg-card border border-border rounded text-[9px] text-text-secondary hover:border-accent hover:text-text-primary transition-colors"
                    >
                      Today
                    </button>
                  </div>
                  <div className="space-y-2">
                    <Field label="Start" value={startDate} onChange={setStartDate} />
                    <Field label="End" value={endDate} onChange={setEndDate} />
                    <Field label="Prev Close Start" value={closingStart} onChange={setClosingStart} />
                    <Field label="Prev Close End" value={closingEnd} onChange={setClosingEnd} />
                  </div>
                </div>

                {/* Strategy */}
                <div>
                  <h3 className="text-[9px] uppercase tracking-[1.5px] text-text-secondary mb-3">Strategy Parameters</h3>
                  <div className="space-y-2">
                    <NumField label="Initial Threshold (%)" value={initThreshold} onChange={setInitThreshold} step={0.01} />
                    <NumField label="Take Profit — Long (%)" value={longPercent} onChange={setLongPercent} step={0.1} />
                    <NumField label="Stop Loss — Short (%)" value={shortPercent} onChange={setShortPercent} step={0.5} />
                  </div>
                  <h3 className="text-[9px] uppercase tracking-[1.5px] text-text-secondary mt-4 mb-2">Presets</h3>
                  <div className="grid grid-cols-2 gap-1.5">
                    {['scalper', 'conservative', 'aggressive', 'tight'].map(p => (
                      <button key={p} onClick={() => applyPreset(p)}
                        className="py-1.5 bg-card border border-border rounded text-[9px] text-text-secondary hover:border-accent hover:text-text-primary capitalize transition-colors">
                        {p}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Capital */}
                <div>
                  <h3 className="text-[9px] uppercase tracking-[1.5px] text-text-secondary mb-3">Capital</h3>
                  <div className="space-y-2">
                    <NumField label="Starting Funds (₹)" value={funds} onChange={setFunds} step={1000} />
                    <NumField label="Base Funds / Min (₹)" value={baseFunds} onChange={setBaseFunds} step={1000} />
                  </div>
                </div>
              </div>

              <div className="mt-6 max-w-3xl flex gap-3">
                <button
                  onClick={runBacktest}
                  disabled={backtestLoading || !selected}
                  className="px-8 py-2.5 rounded-md font-bold text-xs tracking-wide text-white bg-green hover:opacity-85 transition-opacity disabled:opacity-50"
                >
                  {backtestLoading ? '⏳ Running...' : !selected ? 'Select a stock first' : '▶ Run Backtest'}
                </button>
              </div>
            </div>
          ) : (
            /* Backtest Results View */
            <>
              {backtestError && (
                <div className="bg-red/10 border border-red/30 text-red text-xs px-4 py-2">{backtestError}</div>
              )}

              {backtestLoading && (
                <div className="flex items-center justify-center py-8">
                  <span className="text-text-secondary text-sm animate-pulse">Connecting to server & fetching historical data...</span>
                </div>
              )}

              {/* Stats bar */}
              <div className="grid grid-cols-7 gap-2 p-3 bg-secondary border-b border-border shrink-0">
                <StatCard label="Net P&L" value={formatSignedInr(stats.netPnl, { maxFractionDigits: 0 })} colorClass={pnlColor(stats.netPnl)} />
                <StatCard label="Return %" value={`${stats.returnPct.toFixed(2)}%`} colorClass={pnlColor(stats.returnPct)} />
                <StatCard label="Trades" value={stats.totalTrades} />
                <StatCard label="Win Rate" value={stats.totalTrades > 0 ? `${stats.winRate.toFixed(0)}%` : '—'}
                  colorClass={stats.winRate >= 50 ? 'text-green' : 'text-red'} />
                <StatCard label="Total Fees" value={formatInr(stats.totalFees, { maxFractionDigits: 0 })} colorClass="text-red" />
                <StatCard label="Shares Held" value={formatIndianNumber(stats.shares, 0)} />
                <StatCard label="Funds" value={formatInr(stats.funds, { maxFractionDigits: 0 })} />
              </div>

              {/* Back / Re-configure buttons */}
              <div className="flex items-center gap-3 px-3 py-1.5 bg-secondary border-b border-border shrink-0">
                <Link to="/portfolio"
                  className="text-[10px] text-text-secondary hover:text-text-primary transition-colors">
                  ← Portfolio
                </Link>
                <button onClick={() => { stopStream(); setBacktestDone(false) }}
                  className="text-[10px] text-accent hover:text-text-primary transition-colors">
                  ⚙ Change Settings
                </button>
                {backtestDone && (
                  <button onClick={runBacktest}
                    className="text-[10px] text-text-secondary hover:text-text-primary transition-colors">
                    ↻ Replay
                  </button>
                )}
                {streaming && (
                  <span className="text-[10px] text-green animate-pulse ml-auto">● Streaming from server...</span>
                )}
              </div>

              {/* Chart */}
              <div className="flex-1 min-h-[250px] relative" ref={chartContainerRef}>
                <div className="absolute top-2 left-3 z-10 text-[9px] text-text-secondary bg-primary/70 px-2 py-0.5 rounded">
                  — Equity Curve
                </div>
              </div>

              {/* Playback bar */}
              {(streaming || backtestDone) && (
                <div className="flex items-center gap-2.5 px-3 py-2 bg-secondary border-t border-b border-border shrink-0">
                  {streaming && (
                    <PlayBtn onClick={togglePlay} active={playing} label={playing ? '❚❚' : '▶'} />
                  )}

                  <div className="flex-1 bg-[#1e2d3d] rounded h-1.5 overflow-hidden">
                    <div
                      className="h-full bg-accent rounded transition-all duration-200"
                      style={{ width: totalCandles > 0 ? `${(currentIdx / totalCandles) * 100}%` : '0%' }}
                    />
                  </div>

                  <span className="text-[11px] text-text-secondary min-w-[100px] text-right">
                    {currentIdx} / {totalCandles}
                  </span>

                  <select
                    value={speed}
                    onChange={e => changeSpeed(+e.target.value)}
                    className="bg-card border border-border text-text-primary text-[10px] px-1.5 py-1 rounded outline-none"
                  >
                    <option value={500}>0.5x (500ms)</option>
                    <option value={200}>1x (200ms)</option>
                    <option value={100}>2x (100ms)</option>
                    <option value={40}>5x (40ms)</option>
                    <option value={10}>10x (10ms)</option>
                    <option value={2}>MAX</option>
                  </select>
                </div>
              )}

              {/* Order log */}
              <div ref={orderLogRef} className="h-[200px] bg-secondary border-t border-border overflow-auto shrink-0">
                <h3 className="text-[9px] uppercase tracking-[1.5px] text-text-secondary px-3 py-2 sticky top-0 bg-secondary z-10">
                  Order Log (live)
                </h3>
                <table className="w-full border-collapse text-[10px]">
                  <thead>
                    <tr className="text-text-secondary text-[8px] uppercase tracking-wider sticky top-7 bg-secondary z-10">
                      <th className="text-left py-1 px-3">#</th>
                      <th className="text-left py-1 px-3">Time</th>
                      <th className="text-left py-1 px-3">Type</th>
                      <th className="text-right py-1 px-3">Price</th>
                      <th className="text-right py-1 px-3">Qty</th>
                      <th className="text-right py-1 px-3">Amount</th>
                      <th className="text-right py-1 px-3">Fee</th>
                      <th className="text-right py-1 px-3">P&L</th>
                      <th className="text-right py-1 px-3">Net</th>
                      <th className="text-left py-1 px-3">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      let net = 0
                      return displayedOrders.map((o, i) => {
                        if (o.type === 'SELL') net += +o.pnl
                        return (
                          <tr key={i} className="border-b border-border/20 hover:bg-accent/5">
                            <td className="py-1 px-3">{i + 1}</td>
                            <td className="py-1 px-3">{o.timeStr}</td>
                            <td className="py-1 px-3">
                              <span className={`inline-block px-1.5 py-0.5 rounded text-[8px] font-bold ${
                                o.type === 'BUY' ? 'bg-green/15 text-green' : 'bg-red/15 text-red'
                              }`}>{o.type}</span>
                            </td>
                            <td className="py-1 px-3 text-right">{formatInr(o.price)}</td>
                            <td className="py-1 px-3 text-right">{formatIndianNumber(o.qty, 0)}</td>
                            <td className="py-1 px-3 text-right">{formatInr(o.amount, { maxFractionDigits: 0 })}</td>
                            <td className="py-1 px-3 text-right text-red">
                              {o.type === 'SELL' && o.fee ? formatInr(o.fee, { maxFractionDigits: 0 }) : ''}
                            </td>
                            <td className={`py-1 px-3 text-right ${o.type === 'SELL' ? pnlColor(o.pnl) : ''}`}>
                              {o.type === 'SELL' ? formatSignedInr(o.pnl, { maxFractionDigits: 0 }) : ''}
                            </td>
                            <td className={`py-1 px-3 text-right ${o.type === 'SELL' ? pnlColor(net) : ''}`}>
                              {o.type === 'SELL' ? formatInr(net, { maxFractionDigits: 0 }) : ''}
                            </td>
                            <td className="py-1 px-3 text-left text-text-secondary text-[9px]">
                              {o.reason || ''}
                            </td>
                          </tr>
                        )
                      })
                    })()}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Toasts */}
      <div className="fixed top-16 right-5 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => <Toast key={t.id} order={t} />)}
      </div>
    </div>
  )
}

// ── Small components ──

function Field({ label, value, onChange }) {
  return (
    <div>
      <label className="block text-[10px] text-text-secondary mb-1">{label}</label>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full px-2 py-1.5 bg-primary border border-border rounded text-text-primary text-[11px] outline-none focus:border-accent"
      />
    </div>
  )
}

function NumField({ label, value, onChange, step = 1 }) {
  return (
    <div>
      <label className="block text-[10px] text-text-secondary mb-1">{label}</label>
      <input
        type="number" value={value} step={step}
        onChange={e => onChange(+e.target.value)}
        className="w-full px-2 py-1.5 bg-primary border border-border rounded text-text-primary text-[11px] outline-none focus:border-accent"
      />
    </div>
  )
}

function PlayBtn({ onClick, label, active }) {
  return (
    <button
      onClick={onClick}
      className={`w-8 h-8 rounded-full border flex items-center justify-center text-sm cursor-pointer transition-colors ${
        active ? 'bg-accent border-accent' : 'bg-card border-border hover:bg-accent hover:border-accent'
      } text-text-primary`}
    >
      {label}
    </button>
  )
}
