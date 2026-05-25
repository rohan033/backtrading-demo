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
