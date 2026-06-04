/** Turn FastAPI / fetch error bodies into a readable string. */
export function formatApiError(body: unknown, fallback = 'Request failed'): string {
  if (body == null) return fallback
  if (typeof body === 'string') return body
  if (typeof body !== 'object') return fallback

  const record = body as Record<string, unknown>
  if (typeof record.message === 'string' && record.message.trim()) {
    return record.message
  }
  if (typeof record.detail === 'string' && record.detail.trim()) {
    return record.detail
  }
  if (Array.isArray(record.detail)) {
    const parts = record.detail.map(item => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object' && 'msg' in item) {
        return String((item as { msg: unknown }).msg)
      }
      return null
    }).filter(Boolean)
    if (parts.length) return parts.join('; ')
  }
  if (record.detail && typeof record.detail === 'object') {
    try {
      return JSON.stringify(record.detail)
    } catch {
      return fallback
    }
  }
  return fallback
}

export function errorMessage(error: unknown, fallback = 'Request failed'): string {
  if (error instanceof Error) {
    const msg = error.message?.trim()
    return msg && msg !== '[object Object]' ? msg : fallback
  }
  if (typeof error === 'string') return error
  return formatApiError(error, fallback)
}
