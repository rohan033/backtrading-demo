import { formatApiError } from './apiError'
import { showPlatformToast } from './platform-toast'

export type PositionCloseNotifyContext = {
  source?: 'positions' | 'momentum' | 'bracket'
  ticker?: string
  symbol_name?: string | null
  buy_price?: number | null
  sell_price?: number | null
  pnl?: number | null
  pnl_pct?: number | null
  close_reason?: string
  take_profit_config?: string
  stop_loss_config?: string
}

export type CloseEtoroDebug = {
  request?: Record<string, unknown> | null
  response?: unknown
}

export type SettledCloseFields = {
  buy_price?: number | null
  sell_price?: number | null
  pnl?: number | null
  pnl_pct?: number | null
  settled_from?: string
}

export type CloseEtoroPositionResult = {
  debug?: CloseEtoroDebug | null
  settled?: SettledCloseFields | null
  settlement_pending?: boolean
  position_id?: string
  account_env?: string
}

export class CloseEtoroPositionError extends Error {
  debug?: CloseEtoroDebug | null

  constructor(message: string, debug?: CloseEtoroDebug | null) {
    super(message)
    this.name = 'CloseEtoroPositionError'
    this.debug = debug
  }
}

function parseCloseErrorPayload(data: Record<string, unknown>): { message: string; debug?: CloseEtoroDebug | null } {
  const detail = data.detail
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const record = detail as Record<string, unknown>
    const message = typeof record.message === 'string'
      ? record.message
      : formatApiError(data, 'Failed to close position')
    const debug = record.debug && typeof record.debug === 'object'
      ? record.debug as CloseEtoroDebug
      : null
    return { message, debug }
  }
  return {
    message: formatApiError(data, 'Failed to close position'),
    debug: null,
  }
}

export function formatCloseEtoroDebug(debug?: CloseEtoroDebug | null, maxLen = 900): string {
  if (!debug?.request && debug?.response == null) return ''
  const chunks = [
    debug.request ? `Request: ${JSON.stringify(debug.request, null, 2)}` : '',
    debug.response != null ? `Response: ${JSON.stringify(debug.response, null, 2)}` : '',
  ].filter(Boolean)
  const text = chunks.join('\n\n')
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}…`
}

export function logCloseEtoroExchange(
  label: string,
  result: CloseEtoroPositionResult | null,
  error?: CloseEtoroPositionError | null,
) {
  if (error) {
    console.error(`[eToro close] ${label} failed`, {
      message: error.message,
      debug: error.debug,
    })
    return
  }
  console.info(`[eToro close] ${label} ok`, result?.debug ?? null)
}

function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}$${value.toFixed(2)}`
}

function pct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return ''
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

export async function pollEtoroCloseSettlement(
  positionId: string,
  {
    timeoutMs = 60_000,
    intervalMs = 1500,
  }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ status: string; settled?: SettledCloseFields | null; ticker?: string | null }> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(
      `/api/control/etoro/positions/${encodeURIComponent(positionId)}/settlement`,
    )
    if (res.ok) {
      const payload = await res.json() as {
        status?: boolean
        data?: {
          status?: string
          ticker?: string
          settled?: SettledCloseFields
          message?: string
        }
      }
      const data = payload.data
      const status = String(data?.status || 'unknown')
      if (status === 'settled' || status === 'timeout' || status === 'failed') {
        return {
          status,
          settled: data?.settled ?? null,
          ticker: data?.ticker ?? null,
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  return { status: 'timeout' }
}

/** After close: if history lagged, poll background settle and toast the final fill. */
export function watchCloseSettlement(
  result: CloseEtoroPositionResult,
  label?: string,
): void {
  const positionId = result.position_id
  if (!positionId || !result.settlement_pending) return

  const ticker = label || positionId
  showPlatformToast({
    variant: 'default',
    title: 'Settling fill…',
    message: `${ticker}: waiting for eToro trade history`,
    duration: 6000,
  })

  void pollEtoroCloseSettlement(positionId)
    .then(job => {
      if (job.status === 'settled' && job.settled) {
        const sell = job.settled.sell_price
        const pnl = job.settled.pnl
        const pnlPct = job.settled.pnl_pct
        showPlatformToast({
          variant: 'success',
          title: 'Fill settled',
          message: `${job.ticker || ticker}: sell ${sell != null ? `$${Number(sell).toFixed(4)}` : '—'} · ${money(pnl)}${pnlPct != null ? ` (${pct(pnlPct)})` : ''}`,
          duration: 10000,
        })
        return
      }
      showPlatformToast({
        variant: 'warning',
        title: 'Settlement pending',
        message: `${ticker}: eToro history not ready — Order activity may still show the live estimate`,
        duration: 10000,
      })
    })
    .catch(() => {
      // Non-fatal: DB may still update in the background.
    })
}

export async function closeEtoroPosition(
  positionId: string,
  accountEnv: string,
  {
    units,
    instrumentId,
    notify,
  }: {
    units?: number | null
    instrumentId?: string | number | null
    notify?: PositionCloseNotifyContext | null
  } = {},
): Promise<CloseEtoroPositionResult> {
  const requestBody = {
    units: units ?? null,
    instrument_id: instrumentId != null ? Number(instrumentId) : null,
    notify: notify ?? null,
  }
  const params = new URLSearchParams({ account_env: accountEnv })
  const url = `/api/control/etoro/positions/${encodeURIComponent(positionId)}/close?${params.toString()}`

  console.info('[eToro close] sending', { url, body: requestBody })

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  })
  const data = await res.json() as Record<string, unknown>
  console.info('[eToro close] response', { status: res.status, data })

  if (!res.ok || !data.status) {
    const { message, debug } = parseCloseErrorPayload(data)
    throw new CloseEtoroPositionError(message, debug)
  }

  const debug = data.debug && typeof data.debug === 'object'
    ? {
        request: (data.debug as Record<string, unknown>).request as Record<string, unknown> | undefined,
        response: (data.debug as Record<string, unknown>).response,
      }
    : null

  const settled = data.settled && typeof data.settled === 'object'
    ? data.settled as SettledCloseFields
    : null

  return {
    debug,
    settled,
    settlement_pending: Boolean(data.settlement_pending),
    position_id: String(data.position_id || positionId),
    account_env: String(data.account_env || accountEnv),
  }
}
