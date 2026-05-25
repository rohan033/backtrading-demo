export function parseDbTimestamp(value: string | number | null | undefined): Date | null {
  if (value == null || value === '') return null

  if (typeof value === 'number') {
    const date = new Date(value < 1e12 ? value * 1000 : value)
    return Number.isNaN(date.getTime()) ? null : date
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatDbTimestamp(value: string | number | null | undefined): string {
  const date = parseDbTimestamp(value)
  if (!date) return '—'

  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function formatRelativeTimestamp(value: string | number | null | undefined): string {
  const date = parseDbTimestamp(value)
  if (!date) return '—'

  const diffSec = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
  if (diffSec < 5) return 'just now'
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  return `${Math.floor(diffHr / 24)}d ago`
}

export function heartbeatAgeSeconds(value: string | number | null | undefined): number | null {
  const date = parseDbTimestamp(value)
  if (!date) return null
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000))
}
