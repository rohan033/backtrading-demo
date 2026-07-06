import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { flattenEtoroOrders, fetchEtoroOrders, fetchEtoroPositions } from '../lib/etoro-account-data'
import { computeLivePnl, formatPnl, type LivePnl } from '../lib/positionPnl'
import { watchlistTickKey } from '../lib/watchlists'
import type { WatchlistTick } from '../lib/watchlists'
import {
  loadMomentumTrades,
  WL_MOMENTUM_TRADE_EVENT,
  type MomentumTrade,
} from '../lib/watchlistMomentumState'

export type MomentumTradeStatus = 'pending' | 'open' | 'closed' | 'error'

export type MomentumTradeBrokerOrder = {
  kind: string
  orderId: string
  statusId: string | null
  pending: boolean
}

export type MomentumTradeOrderStatus = 'pending' | 'filled' | 'cancelled' | 'unknown'

export type MomentumTradeOpenPosition = {
  positionId: string
  units: number | null
  instrumentId: string | number | null
  closable: boolean
  onBroker: boolean
}

export type MonitoredMomentumTrade = MomentumTrade & {
  status: MomentumTradeStatus
  livePnl: LivePnl | null
  realizedPnl: number | null
  realizedPnlPct: number | null
  lastCheckedAt: number | null
  errorMessage: string | null
  positionId: string | number | null
  orderId: string | number | null
  orderStatus: MomentumTradeOrderStatus
  orderKind: string | null
  units: number | null
  brokerLtp: number | null
  pendingOrderCount: number
  dataSource: 'etoro' | 'control' | null
  brokerOrders: MomentumTradeBrokerOrder[]
  openPositions: MomentumTradeOpenPosition[]
}

type TradeSnapshot = Omit<MonitoredMomentumTrade, keyof MomentumTrade>

type PositionRow = {
  state?: string
  position_id?: string | number
  order_id?: string | number | null
  remaining_units?: number | null
  position?: Record<string, unknown>
}

const DEFAULT_POLL_MS = 15_000

type EtoroEnvCache = {
  rawPositions: Record<string, unknown>[]
  orders: Array<Record<string, unknown>>
  fetchedAt: number
}

function normalizeState(state: unknown): string {
  return String(state || '').trim().toLowerCase()
}

function isOpenRow(row: PositionRow): boolean {
  const state = normalizeState(row.state || row.position?.state)
  if (state === 'closed' || state === 'cancelled' || state === 'rejected') return false
  const units = Number(
    row.remaining_units
    ?? row.position?.remainingUnits
    ?? row.position?.units
    ?? row.position?.Units
    ?? null,
  )
  if (Number.isFinite(units) && units <= 0) return false
  return true
}

function extractClosedPnl(row: PositionRow): { pnl: number | null; pnlPct: number | null } {
  const pos = row.position || {}
  const nested = (pos.closingData || pos.closing_data || pos) as Record<string, unknown>
  const pnlRaw = nested.pnl ?? nested.pnL ?? nested.PnL ?? nested.profit ?? pos.pnl ?? pos.pnL
  const pctRaw = nested.pnl_pct ?? nested.pnlPct ?? nested.pnlPercent ?? pos.pnl_pct
  const pnl = pnlRaw == null ? null : Number(pnlRaw)
  const pnlPct = pctRaw == null ? null : Number(pctRaw)
  return {
    pnl: Number.isFinite(pnl as number) ? (pnl as number) : null,
    pnlPct: Number.isFinite(pnlPct as number) ? (pnlPct as number) : null,
  }
}

function extractEtoroLivePnl(
  row: Record<string, unknown>,
  livePrice: number | null | undefined,
): LivePnl | null {
  const unrl = row.unrealizedPnL
  let pnl: number | null = null
  if (typeof unrl === 'number' && Number.isFinite(unrl)) {
    pnl = unrl
  } else if (unrl && typeof unrl === 'object') {
    const nested = unrl as Record<string, unknown>
    const raw = nested.pnL ?? nested.pnl ?? nested.PnL
    if (raw != null) {
      const n = Number(raw)
      if (Number.isFinite(n)) pnl = n
    }
  }

  const openRate = Number(row.openRate ?? row.OpenRate ?? row.open ?? 0)
  const currentRate = Number(
    row.currentRate ?? row.CurrentRate ?? row.rate ?? livePrice ?? openRate,
  )
  const isBuy = row.isBuy ?? row.IsBuy ?? true
  const direction = isBuy ? 1 : -1

  if (pnl != null && openRate > 0) {
    const pnlPct = ((currentRate - openRate) / openRate) * 100 * direction
    return { pnl, pnl_pct: pnlPct, current_rate: currentRate }
  }
  return null
}

function brokerLtpFromRow(row: Record<string, unknown> | undefined): number | null {
  if (!row) return null
  const raw = row.currentRate ?? row.CurrentRate ?? row.ltp ?? row.rate
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

function positionIdFromControlRow(row: PositionRow): string | null {
  const raw = row.position_id
    ?? row.position?.positionID
    ?? row.position?.positionId
    ?? row.position?.position_id
  return raw == null ? null : String(raw)
}

function orderIdFromControlRow(row: PositionRow): string | null {
  const raw = row.order_id
    ?? row.position?.orderID
    ?? row.position?.orderId
    ?? row.position?.order_id
  return raw == null ? null : String(raw)
}

function isTerminalEngineStatus(status: string | null | undefined): boolean {
  const value = normalizeState(status)
  return ['stopped', 'completed', 'idle', 'failed', 'error', 'cancelled'].includes(value)
}

function isRunningEngineStatus(status: string | null | undefined): boolean {
  const value = normalizeState(status)
  return ['running', 'starting', 'active'].includes(value)
}

async function fetchExecutionEngineStatus(executionId: string): Promise<string | null> {
  if (!executionId) return null
  try {
    const res = await fetch(`/api/control/engines/${encodeURIComponent(executionId)}`)
    if (!res.ok) return null
    const data = await res.json()
    const status = data?.data?.status
    return status == null ? null : String(status)
  } catch {
    return null
  }
}

async function fetchControlOrders(executionId: string): Promise<ControlOrderRow[]> {
  if (!executionId) return []
  try {
    const res = await fetch(
      `/api/control/orders?executor_id=${encodeURIComponent(executionId)}&limit=20`,
    )
    const data = await res.json()
    if (!data.status) return []
    return Object.values(data.data || {}) as ControlOrderRow[]
  } catch {
    return []
  }
}

type ControlOrderRow = {
  order_id?: string | number
  order_type?: string
  status?: string
  symbol?: string
  quantity?: number
  entry_price?: number
  poll_job_status?: string
  lookup?: {
    action?: string
    status?: { id?: number; name?: string }
    asset?: { symbol?: string }
  }
}

function pickEntryOrder(orders: ControlOrderRow[]): ControlOrderRow | null {
  if (!orders.length) return null
  const entry = orders.find(order => {
    const action = String(order.lookup?.action || '').toLowerCase()
    if (action === 'open' || action === 'buy') return true
    const type = String(order.order_type || order.status || '').toUpperCase()
    return type.includes('BUY') || type === 'OPEN'
  })
  if (entry?.order_id != null) return entry
  const withId = orders.find(order => order.order_id != null)
  return withId || orders[0]
}

function isPendingEtoroOrderKind(kind: string): boolean {
  return kind === 'Open' || kind === 'Close' || kind === 'Limit'
}

function findEtoroOrderRow(
  orderId: string | null,
  symbol: string,
  etoroOrders: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (orderId) {
    const byId = etoroOrders.find(row => String(row.order_id) === String(orderId))
    if (byId) return byId
  }
  const normalized = symbol.trim().toUpperCase()
  if (!normalized) return undefined
  return etoroOrders.find(row => String(row.symbol || '').trim().toUpperCase() === normalized)
}

function resolveEtoroOrderLifecycle(
  orderId: string | null | undefined,
  symbol: string,
  etoroOrders: Array<Record<string, unknown>>,
  hasBrokerPosition: boolean,
): { status: MomentumTradeOrderStatus; kind: string | null } {
  const match = findEtoroOrderRow(
    orderId == null ? null : String(orderId),
    symbol,
    etoroOrders,
  )
  if (match) {
    const kind = String(match.kind || '')
    if (isPendingEtoroOrderKind(kind)) {
      return { status: 'pending', kind }
    }
    return { status: 'unknown', kind: kind || null }
  }
  if (hasBrokerPosition) return { status: 'filled', kind: null }
  return { status: 'unknown', kind: null }
}

async function fetchExecutionPositions(executionId: string): Promise<PositionRow[]> {
  if (!executionId) return []
  try {
    const res = await fetch(`/api/control/executions/${encodeURIComponent(executionId)}/positions`)
    const data = await res.json()
    if (!data.status) return []
    return (data.data || []) as PositionRow[]
  } catch {
    return []
  }
}

async function fetchEtoroEnvCache(env: 'demo' | 'live'): Promise<EtoroEnvCache> {
  try {
    const [positionsRes, ordersRes] = await Promise.all([
      fetchEtoroPositions(env, { refresh: true }),
      fetchEtoroOrders(env),
    ])
    return {
      rawPositions: (positionsRes.raw || positionsRes.data || []) as Record<string, unknown>[],
      orders: flattenEtoroOrders(ordersRes.data),
      fetchedAt: Date.now(),
    }
  } catch {
    return { rawPositions: [], orders: [], fetchedAt: Date.now() }
  }
}

function matchEtoroPositionById(
  rawPositions: Record<string, unknown>[],
  positionId: string,
): Record<string, unknown> | undefined {
  return rawPositions.find(row => {
    const id = row.positionID ?? row.positionId ?? row.position_id
    return id != null && String(id) === positionId
  })
}

function matchEtoroPositionBySymbol(
  rawPositions: Record<string, unknown>[],
  symbol: string,
): Record<string, unknown> | undefined {
  const normalized = symbol.trim().toUpperCase()
  if (!normalized) return undefined
  return rawPositions.find(row => {
    const label = row.symbol
      ?? row.instrumentDisplayName
      ?? row.InstrumentDisplayName
      ?? row.displayName
    return label != null && String(label).trim().toUpperCase() === normalized
  })
}

function matchEtoroOrdersForExecution(
  orders: Array<Record<string, unknown>>,
  orderIds: Set<string>,
  symbol?: string,
): MomentumTradeBrokerOrder[] {
  const normalized = symbol?.trim().toUpperCase() || ''
  return orders
    .filter(order => {
      const id = order.order_id
      if (id != null && orderIds.has(String(id))) return true
      if (normalized && String(order.symbol || '').trim().toUpperCase() === normalized) return true
      return false
    })
    .map(order => ({
      kind: String(order.kind || 'Order'),
      orderId: String(order.order_id),
      statusId: order.status_id == null ? null : String(order.status_id),
      pending: isPendingEtoroOrderKind(String(order.kind || '')),
    }))
}

function resolveTradeSnapshot(
  trade: MomentumTrade,
  positions: PositionRow[],
  livePrice: number | null | undefined,
  extras: {
    positionId: string | number | null
    orderId: string | number | null
    orderStatus: MomentumTradeOrderStatus
    orderKind: string | null
    units: number | null
    brokerLtp: number | null
    pendingOrderCount: number
    dataSource: 'etoro' | 'control' | null
    etoroRaw?: Record<string, unknown> | null
    brokerOrders: MomentumTradeBrokerOrder[]
    engineStatus: string | null
    openPositions: MomentumTradeOpenPosition[]
  },
): TradeSnapshot {
  const checkedAt = Date.now()
  const baseExtras = {
    positionId: extras.positionId,
    orderId: extras.orderId,
    orderStatus: extras.orderStatus,
    orderKind: extras.orderKind,
    units: extras.units,
    brokerLtp: extras.brokerLtp,
    pendingOrderCount: extras.pendingOrderCount,
    dataSource: extras.dataSource,
    brokerOrders: extras.brokerOrders,
    openPositions: extras.openPositions,
  }

  if (!trade.executionId) {
    return {
      status: 'error',
      livePnl: null,
      realizedPnl: null,
      realizedPnlPct: null,
      lastCheckedAt: checkedAt,
      errorMessage: 'Missing execution id',
      ...baseExtras,
    }
  }

  const hasBrokerPosition = extras.openPositions.some(pos => pos.onBroker)
  const brokerOrderPending =
    extras.orderStatus === 'pending' || extras.pendingOrderCount > 0

  // eToro pending open orders beat stale control-plane position snapshots.
  if (brokerOrderPending && !hasBrokerPosition) {
    return {
      status: 'pending',
      livePnl: null,
      realizedPnl: null,
      realizedPnlPct: null,
      lastCheckedAt: checkedAt,
      errorMessage: null,
      ...baseExtras,
    }
  }

  if (!positions.length) {
    const ageMs = Date.now() - trade.createdAt
    const stillWarmingUp = isRunningEngineStatus(extras.engineStatus) && ageMs < 120_000
    const orderStillPending = extras.orderStatus === 'pending'
    if (orderStillPending || extras.pendingOrderCount > 0 || stillWarmingUp) {
      return {
        status: 'pending',
        livePnl: null,
        realizedPnl: null,
        realizedPnlPct: null,
        lastCheckedAt: checkedAt,
        errorMessage: null,
        ...baseExtras,
      }
    }
    return {
      status: 'closed',
      livePnl: null,
      realizedPnl: null,
      realizedPnlPct: null,
      lastCheckedAt: checkedAt,
      errorMessage: null,
      ...baseExtras,
    }
  }

  const open = positions.filter(isOpenRow)
  const brokerIsEtoro = (trade.broker || '').toLowerCase() === 'etoro'
  const brokerFlat = !extras.etoroRaw && extras.pendingOrderCount === 0

  if (open.length > 0 && brokerIsEtoro && brokerFlat) {
    return {
      status: 'closed',
      livePnl: null,
      realizedPnl: null,
      realizedPnlPct: null,
      lastCheckedAt: checkedAt,
      errorMessage: null,
      ...baseExtras,
    }
  }

  if (open.length > 0 && isTerminalEngineStatus(extras.engineStatus) && brokerFlat) {
    return {
      status: 'closed',
      livePnl: null,
      realizedPnl: null,
      realizedPnlPct: null,
      lastCheckedAt: checkedAt,
      errorMessage: null,
      ...baseExtras,
    }
  }

  if (open.length > 0 && extras.orderStatus === 'pending' && !extras.openPositions.some(pos => pos.onBroker)) {
    return {
      status: 'pending',
      livePnl: null,
      realizedPnl: null,
      realizedPnlPct: null,
      lastCheckedAt: checkedAt,
      errorMessage: null,
      ...baseExtras,
    }
  }

  if (open.length > 0) {
    const priceForPnl = extras.brokerLtp ?? livePrice
    const etoroPnl = extras.etoroRaw ? extractEtoroLivePnl(extras.etoroRaw, priceForPnl) : null
    const livePnls = open
      .map(row => etoroPnl ?? computeLivePnl(row, priceForPnl))
      .filter((item): item is LivePnl => item != null)
    const totalPnl = livePnls.length
      ? livePnls.reduce((sum, item) => sum + item.pnl, 0)
      : null
    const totalPct = livePnls.length
      ? livePnls.reduce((sum, item) => sum + item.pnl_pct, 0) / livePnls.length
      : null
    return {
      status: 'open',
      livePnl: totalPnl == null ? null : {
        pnl: totalPnl,
        pnl_pct: totalPct ?? 0,
        current_rate: priceForPnl ?? 0,
      },
      realizedPnl: null,
      realizedPnlPct: null,
      lastCheckedAt: checkedAt,
      errorMessage: null,
      ...baseExtras,
    }
  }

  const closedPnls = positions.map(extractClosedPnl).filter(item => item.pnl != null)
  const realizedPnl = closedPnls.length
    ? closedPnls.reduce((sum, item) => sum + (item.pnl ?? 0), 0)
    : null
  const realizedPnlPct = closedPnls.length
    ? closedPnls.reduce((sum, item) => sum + (item.pnlPct ?? 0), 0) / closedPnls.length
    : null

  return {
    status: 'closed',
    livePnl: null,
    realizedPnl,
    realizedPnlPct,
    lastCheckedAt: checkedAt,
    errorMessage: null,
    ...baseExtras,
  }
}

async function resolveTradeBrokerData(
  trade: MomentumTrade,
  controlRows: PositionRow[],
  controlOrders: ControlOrderRow[],
  etoroCache: EtoroEnvCache | null,
): Promise<{
  positions: PositionRow[]
  positionId: string | number | null
  orderId: string | number | null
  orderStatus: MomentumTradeOrderStatus
  orderKind: string | null
  units: number | null
  brokerLtp: number | null
  pendingOrderCount: number
  dataSource: 'etoro' | 'control' | null
  etoroRaw: Record<string, unknown> | null
  brokerOrders: MomentumTradeBrokerOrder[]
  openPositions: MomentumTradeOpenPosition[]
}> {
  const positionIds = new Set(
    controlRows.map(positionIdFromControlRow).filter((id): id is string => Boolean(id)),
  )
  const executionOrderIds = new Set<string>([
    ...controlOrders.map(order => order.order_id).filter(Boolean).map(id => String(id)),
    ...controlRows.map(orderIdFromControlRow).filter((id): id is string => Boolean(id)),
  ])

  const entryOrder = pickEntryOrder(controlOrders)
  let orderId: string | number | null = entryOrder?.order_id ?? null

  let dataSource: 'etoro' | 'control' | null = controlRows.length || controlOrders.length ? 'control' : null
  let etoroRaw: Record<string, unknown> | null = null
  let brokerLtp: number | null = null
  let positionId: string | number | null = controlRows[0]?.position_id ?? null
  let units: number | null = controlRows[0]?.remaining_units ?? null
  let brokerOrders: MomentumTradeBrokerOrder[] = []

  if ((trade.broker || '').toLowerCase() === 'etoro' && etoroCache) {
    brokerOrders = matchEtoroOrdersForExecution(
      etoroCache.orders,
      executionOrderIds,
      trade.tradingsymbol,
    )

    const brokerPositionBySymbol = matchEtoroPositionBySymbol(
      etoroCache.rawPositions,
      trade.tradingsymbol,
    )

    const primaryPositionId = [...positionIds][0]
    if (primaryPositionId) {
      const matched = matchEtoroPositionById(etoroCache.rawPositions, primaryPositionId)
      if (matched) {
        etoroRaw = matched
        dataSource = 'etoro'
        positionId = primaryPositionId
        brokerLtp = brokerLtpFromRow(matched)
        units = Number(matched.units ?? matched.Units ?? matched.amount ?? units) || units
      }
    }

    if (!etoroRaw && brokerPositionBySymbol) {
      etoroRaw = brokerPositionBySymbol
      dataSource = 'etoro'
      positionId = brokerPositionBySymbol.positionID
        ?? brokerPositionBySymbol.positionId
        ?? positionId
      brokerLtp = brokerLtpFromRow(brokerPositionBySymbol)
      units = Number(
        brokerPositionBySymbol.units
        ?? brokerPositionBySymbol.Units
        ?? brokerPositionBySymbol.amount
        ?? units,
      ) || units
    }

    const pendingBySymbol = findEtoroOrderRow(
      orderId == null ? null : String(orderId),
      trade.tradingsymbol,
      etoroCache.orders,
    )
    if (pendingBySymbol && isPendingEtoroOrderKind(String(pendingBySymbol.kind || ''))) {
      const pendingId = String(pendingBySymbol.order_id)
      orderId = pendingId
      if (!brokerOrders.some(order => order.orderId === pendingId)) {
        brokerOrders = [
          {
            kind: String(pendingBySymbol.kind || 'Open'),
            orderId: pendingId,
            statusId: pendingBySymbol.status_id == null ? null : String(pendingBySymbol.status_id),
            pending: true,
          },
          ...brokerOrders,
        ]
      }
    }
  }

  const openPositions = controlRows
    .filter(isOpenRow)
    .map(row => {
      const pid = positionIdFromControlRow(row)
      if (!pid) return null
      const etoroMatch = etoroCache
        ? matchEtoroPositionById(etoroCache.rawPositions, pid)
        : undefined
      const nested = row.position || {}
      const instrumentId = (
        nested.instrumentID
        ?? nested.instrumentId
        ?? nested.instrument_id
        ?? etoroMatch?.instrumentID
        ?? etoroMatch?.instrumentId
        ?? trade.symboltoken
        ?? null
      )
      const rowUnits = Number(
        row.remaining_units
        ?? nested.units
        ?? nested.Units
        ?? etoroMatch?.units
        ?? etoroMatch?.Units
        ?? null,
      )
      const onBroker = etoroMatch != null
      return {
        positionId: pid,
        units: Number.isFinite(rowUnits) ? rowUnits : null,
        instrumentId: instrumentId as string | number | null,
        closable: (trade.broker || '').toLowerCase() === 'etoro' && /^\d+$/.test(pid),
        onBroker,
      }
    })
    .filter((row): row is MomentumTradeOpenPosition => row != null)
    .filter(row => {
      if ((trade.broker || '').toLowerCase() !== 'etoro') return true
      return row.onBroker
    })

  const pendingBrokerOrders = brokerOrders.filter(order => order.pending)
  const pendingOrderCount = pendingBrokerOrders.length

  const hasBrokerPosition = etoroCache
    ? (
      matchEtoroPositionBySymbol(etoroCache.rawPositions, trade.tradingsymbol) != null
      || openPositions.some(pos => pos.onBroker)
    )
    : openPositions.some(pos => pos.onBroker)

  const lifecycle = resolveEtoroOrderLifecycle(
    orderId == null ? null : String(orderId),
    trade.tradingsymbol,
    etoroCache?.orders || [],
    hasBrokerPosition,
  )

  if (lifecycle.status === 'pending' && pendingBrokerOrders.length === 0 && orderId) {
    const synthetic = findEtoroOrderRow(String(orderId), trade.tradingsymbol, etoroCache?.orders || [])
    if (synthetic && isPendingEtoroOrderKind(String(synthetic.kind || ''))) {
      brokerOrders = [
        {
          kind: String(synthetic.kind || 'Open'),
          orderId: String(orderId),
          statusId: synthetic.status_id == null ? null : String(synthetic.status_id),
          pending: true,
        },
        ...brokerOrders,
      ]
    }
  }

  let orderStatus = lifecycle.status
  let orderKind = lifecycle.kind
  const pendingCountAfterSync = brokerOrders.filter(order => order.pending).length
  if (orderStatus === 'unknown' && pendingCountAfterSync > 0) {
    orderStatus = 'pending'
    orderKind = pendingBrokerOrders[0]?.kind || orderKind
  }

  return {
    positions: controlRows,
    positionId,
    orderId,
    orderStatus,
    orderKind,
    units,
    brokerLtp,
    pendingOrderCount: pendingCountAfterSync,
    dataSource,
    etoroRaw,
    brokerOrders,
    openPositions,
  }
}

export function formatMonitoredTradePnl(trade: MonitoredMomentumTrade): string | null {
  if (trade.status === 'open' && trade.livePnl) {
    const money = formatPnl(trade.livePnl.pnl)
    if (!money) return null
    const sign = trade.livePnl.pnl_pct >= 0 ? '+' : ''
    return `${money} (${sign}${trade.livePnl.pnl_pct.toFixed(2)}%)`
  }
  if (trade.status === 'closed' && trade.realizedPnl != null) {
    const money = formatPnl(trade.realizedPnl)
    if (!money) return null
    if (trade.realizedPnlPct != null) {
      const sign = trade.realizedPnlPct >= 0 ? '+' : ''
      return `${money} (${sign}${trade.realizedPnlPct.toFixed(2)}%)`
    }
    return money
  }
  return null
}

export type MomentumTradesMonitorResult = {
  trades: MonitoredMomentumTrade[]
  refresh: () => Promise<void>
  isRefreshing: boolean
  lastRefreshedAt: number | null
}

export function useMomentumTradesMonitor(
  ticks: Record<string, WatchlistTick>,
  pollMs = DEFAULT_POLL_MS,
): MomentumTradesMonitorResult {
  const [trades, setTrades] = useState<MomentumTrade[]>(() => loadMomentumTrades())
  const [snapshots, setSnapshots] = useState<Record<string, TradeSnapshot>>({})
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null)
  const refreshInFlight = useRef(false)
  const tradesRef = useRef(trades)
  const ticksRef = useRef(ticks)

  useEffect(() => { tradesRef.current = trades }, [trades])
  useEffect(() => { ticksRef.current = ticks }, [ticks])

  const tradeIdsKey = useMemo(
    () => trades.map(trade => trade.id).join('|'),
    [trades],
  )

  useEffect(() => {
    const sync = () => setTrades(loadMomentumTrades())
    sync()
    const onTrade = () => sync()
    window.addEventListener(WL_MOMENTUM_TRADE_EVENT, onTrade)
    window.addEventListener('storage', onTrade)
    return () => {
      window.removeEventListener(WL_MOMENTUM_TRADE_EVENT, onTrade)
      window.removeEventListener('storage', onTrade)
    }
  }, [])

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    setIsRefreshing(true)

    try {
      const fetchedAt = Date.now()
      const currentTrades = tradesRef.current
      const currentTicks = ticksRef.current

      if (!currentTrades.length) {
        setSnapshots({})
        setLastRefreshedAt(fetchedAt)
        return
      }

      const etoroEnvs = [...new Set(
        currentTrades
          .filter(trade => (trade.broker || '').toLowerCase() === 'etoro')
          .map(trade => trade.accountEnv),
      )] as Array<'demo' | 'live'>

      const etoroCacheByEnv = new Map<'demo' | 'live', EtoroEnvCache>()
      await Promise.all(
        etoroEnvs.map(async env => {
          etoroCacheByEnv.set(env, await fetchEtoroEnvCache(env))
        }),
      )

      const next: Record<string, TradeSnapshot> = {}
      await Promise.all(
        currentTrades.map(async trade => {
          const tickKey = watchlistTickKey(trade.broker, trade.accountEnv, trade.symboltoken)
          const tickPrice = currentTicks[tickKey]?.ltp
          const [controlRows, engineStatus, controlOrders] = await Promise.all([
            fetchExecutionPositions(trade.executionId),
            fetchExecutionEngineStatus(trade.executionId),
            fetchControlOrders(trade.executionId),
          ])
          const etoroCache = etoroCacheByEnv.get(trade.accountEnv) ?? null
          const brokerData = await resolveTradeBrokerData(
            trade,
            controlRows,
            controlOrders,
            etoroCache,
          )

          next[trade.id] = resolveTradeSnapshot(
            trade,
            brokerData.positions,
            brokerData.brokerLtp ?? tickPrice,
            { ...brokerData, engineStatus },
          )
        }),
      )
      setSnapshots(next)
      setLastRefreshedAt(fetchedAt)
    } finally {
      refreshInFlight.current = false
      setIsRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => void refresh(), pollMs)
    return () => window.clearInterval(id)
  }, [refresh, pollMs, tradeIdsKey])

  const monitoredTrades = useMemo(
    () =>
      trades.map(trade => ({
        ...trade,
        ...(snapshots[trade.id] ?? {
          status: 'pending' as const,
          livePnl: null,
          realizedPnl: null,
          realizedPnlPct: null,
          lastCheckedAt: null,
          errorMessage: null,
          positionId: null,
          orderId: null,
          orderStatus: 'unknown' as const,
          orderKind: null,
          units: null,
          brokerLtp: null,
          pendingOrderCount: 0,
          dataSource: null,
          brokerOrders: [],
          openPositions: [],
        }),
      })),
    [trades, snapshots],
  )

  return {
    trades: monitoredTrades,
    refresh,
    isRefreshing,
    lastRefreshedAt,
  }
}
