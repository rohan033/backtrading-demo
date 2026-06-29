export type SortDirection = 'asc' | 'desc'

export type SortState<T extends string> = {
  key: T
  dir: SortDirection
} | null

export function toggleSortState<T extends string>(
  current: SortState<T>,
  key: T,
): SortState<T> {
  if (current?.key !== key) return { key, dir: 'asc' }
  if (current.dir === 'asc') return { key, dir: 'desc' }
  return null
}

export function compareStrings(a: string, b: string, dir: SortDirection): number {
  const cmp = a.localeCompare(b, undefined, { sensitivity: 'base' })
  return dir === 'asc' ? cmp : -cmp
}

export function compareNumbers(
  a: number | null | undefined,
  b: number | null | undefined,
  dir: SortDirection,
): number {
  const av = a ?? (dir === 'asc' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY)
  const bv = b ?? (dir === 'asc' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY)
  if (av === bv) return 0
  return dir === 'asc' ? av - bv : bv - av
}

export function sortIndicator(active: boolean, dir: SortDirection | undefined): string {
  if (!active) return '↕'
  return dir === 'asc' ? '↑' : '↓'
}
