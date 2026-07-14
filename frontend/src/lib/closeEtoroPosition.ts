import { formatApiError } from './apiError'

export type CloseEtoroDebug = {
  request?: Record<string, unknown> | null
  response?: unknown
}

export type CloseEtoroPositionResult = {
  debug?: CloseEtoroDebug | null
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

export async function closeEtoroPosition(
  positionId: string,
  accountEnv: string,
  {
    units,
    instrumentId,
  }: {
    units?: number | null
    instrumentId?: string | number | null
  } = {},
): Promise<CloseEtoroPositionResult> {
  const requestBody = {
    units: units ?? null,
    instrument_id: instrumentId != null ? Number(instrumentId) : null,
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

  return { debug }
}
