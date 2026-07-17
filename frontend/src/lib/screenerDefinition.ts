import type { ScreenerDefinition, ScreenerFilterCond, ScreenerFilterGroup } from './screenerApi'

function formatValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return `[${value.map(formatValue).join(', ')}]`
  return JSON.stringify(value)
}

function formatCond(cond: ScreenerFilterCond): string {
  const left = `Column(${JSON.stringify(cond.left)})`
  const op = cond.operation
  const right = cond.right
  if (op === 'greater') return `${left} > ${formatValue(right)}`
  if (op === 'egreater') return `${left} >= ${formatValue(right)}`
  if (op === 'less') return `${left} < ${formatValue(right)}`
  if (op === 'eless') return `${left} <= ${formatValue(right)}`
  if (op === 'equal') return `${left} == ${formatValue(right)}`
  if (op === 'nequal') return `${left} != ${formatValue(right)}`
  if (op === 'in_range') {
    if (Array.isArray(right) && right.length === 2) {
      return `${left}.between(${formatValue(right[0])}, ${formatValue(right[1])})`
    }
    return `${left}.isin(${formatValue(right)})`
  }
  if (op === 'not_in_range') {
    if (Array.isArray(right) && right.length === 2) {
      return `${left}.not_between(${formatValue(right[0])}, ${formatValue(right[1])})`
    }
    return `${left}.not_in(${formatValue(right)})`
  }
  if (op === 'has') return `${left}.has(${formatValue(right)})`
  if (op === 'has_none_of') return `${left}.has_none_of(${formatValue(right)})`
  if (op === 'match') return `${left}.like(${formatValue(right)})`
  if (op === 'nmatch') return `${left}.not_like(${formatValue(right)})`
  if (op === 'empty') return `${left}.empty()`
  if (op === 'nempty') return `${left}.not_empty()`
  return `${left} /* ${op} */ ${formatValue(right)}`
}

function formatGroup(group: ScreenerFilterGroup): string {
  const fn = group.operator === 'or' ? 'Or' : 'And'
  const parts = group.conditions.map(child =>
    'operator' in child && 'conditions' in child
      ? formatGroup(child as ScreenerFilterGroup)
      : formatCond(child as ScreenerFilterCond),
  )
  return `${fn}(${parts.join(', ')})`
}

/** Client-side definition → DSL mirror of the server serializer. */
export function definitionToDsl(defn: ScreenerDefinition): string {
  const market = defn.market || 'america'
  const lines: string[] = [
    'from tradingview_screener import Query, Column',
    '',
    market === 'america' ? 'query = (Query()' : `query = (Query(${JSON.stringify(market)})`,
  ]
  const cols = (defn.columns || []).map(c => JSON.stringify(c)).join(', ')
  lines.push(`    .select(${cols})`)
  if (defn.filters?.length) {
    const args = defn.filters.map(formatCond).join(',\n        ')
    lines.push(`    .where(\n        ${args}\n    )`)
  }
  if (defn.filter_group?.conditions?.length) {
    lines.push(`    .where2(${formatGroup(defn.filter_group)})`)
  }
  if (defn.order_by) {
    lines.push(`    .order_by(${JSON.stringify(defn.order_by)}, ascending=${defn.ascending ? 'True' : 'False'})`)
  }
  if (defn.offset) lines.push(`    .offset(${Number(defn.offset)})`)
  lines.push(`    .limit(${Number(defn.limit || 50)})`)
  lines.push(')')
  return `${lines.join('\n')}\n`
}

export function emptyDefinition(): ScreenerDefinition {
  return {
    columns: [
      'name',
      'premarket_change',
      'premarket_close',
      'premarket_change_abs',
      'premarket_volume',
      'premarket_gap',
      'close',
      'change',
      'volume',
      'market_cap_basic',
      'Perf.1Y.MarketCap',
    ],
    filters: [
      { left: 'premarket_change', operation: 'greater', right: 5 },
      { left: 'close', operation: 'less', right: 20 },
      { left: 'premarket_volume', operation: 'greater', right: 100000 },
    ],
    filter_group: null,
    order_by: 'premarket_change',
    ascending: false,
    limit: 50,
    offset: 0,
    market: 'america',
  }
}

export function formatScreenerNumber(value: unknown, kind?: string): string {
  if (value === null || value === undefined || value === '') return '—'
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return String(value)
  if (kind === 'percent') {
    const sign = n > 0 ? '+' : ''
    return `${sign}${n.toFixed(2)}%`
  }
  if (kind === 'price') {
    if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
    return n.toFixed(n < 1 ? 4 : 2)
  }
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} B`
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} M`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(2)} K`
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

export function tickerSymbol(ticker: string): string {
  const raw = (ticker || '').trim()
  const idx = raw.indexOf(':')
  return idx >= 0 ? raw.slice(idx + 1) : raw
}

export function isFilterGroup(
  item: ScreenerFilterCond | ScreenerFilterGroup,
): item is ScreenerFilterGroup {
  return Boolean(item && typeof item === 'object' && 'operator' in item && 'conditions' in item)
}
