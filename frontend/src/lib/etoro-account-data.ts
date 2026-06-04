export type EtoroOrdersSnapshot = {
  orders?: Record<string, unknown>[]
  orders_for_open?: Record<string, unknown>[]
  orders_for_close?: Record<string, unknown>[]
}

export type EtoroOrdersResponse = {
  status: boolean
  broker?: string
  account_env?: string
  data?: EtoroOrdersSnapshot
  counts?: {
    orders: number
    orders_for_open: number
    orders_for_close: number
    total: number
  }
  message?: string
}

export type EtoroPositionsResponse = {
  status: boolean
  broker?: string
  account_env?: string
  data?: Record<string, unknown>[]
  raw?: Record<string, unknown>[]
  raw_count?: number
  cached?: boolean
  stale?: boolean
  message?: string
}

function firstValue(row: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = row[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return null
}

export function flattenEtoroOrders(snapshot: EtoroOrdersSnapshot | undefined) {
  if (!snapshot) return []

  const sections = [
    ['Open', snapshot.orders_for_open || []],
    ['Close', snapshot.orders_for_close || []],
    ['Limit', snapshot.orders || []],
  ] as const

  const rows: Array<Record<string, unknown>> = []
  for (const [kind, items] of sections) {
    for (const item of items) {
      rows.push({
        kind,
        order_id: firstValue(item, 'orderID', 'orderId', 'OrderID'),
        instrument_id: firstValue(item, 'instrumentID', 'instrumentId', 'InstrumentID'),
        symbol: firstValue(
          item,
          'symbol',
          'instrumentDisplayName',
          'InstrumentDisplayName',
          'symbolFull',
          'internalSymbolFull',
          'displayName',
          'DisplayName',
        ),
        status_id: firstValue(item, 'statusID', 'statusId', 'StatusID'),
        amount: firstValue(item, 'amount', 'Amount'),
        units: firstValue(item, 'units', 'Units', 'amountInUnits', 'AmountInUnits'),
        raw: item,
      })
    }
  }
  return rows
}

export async function fetchEtoroPositions(
  accountEnv: string,
  { refresh = true }: { refresh?: boolean } = {},
): Promise<EtoroPositionsResponse> {
  const params = new URLSearchParams({ account_env: accountEnv })
  if (refresh) params.set('refresh', 'true')
  const res = await fetch(`/api/control/etoro/positions?${params.toString()}`)
  return res.json()
}

export async function fetchEtoroOrders(accountEnv: string): Promise<EtoroOrdersResponse> {
  const params = new URLSearchParams({ account_env: accountEnv })
  const res = await fetch(`/api/control/etoro/orders?${params.toString()}`)
  return res.json()
}
