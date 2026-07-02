import type { A2uiStockPick, A2uiSurfaceMessage } from '@/lib/agentA2uiCatalog'

function normalizePickSymbol(row: Record<string, unknown>): string {
  const candidates = [row.symbol, row.ticker, row.name]
  for (const value of candidates) {
    const text = String(value || '').trim()
    if (!text) continue
    const root = text.toUpperCase().split(/[\s-]/)[0]
    if (root) return root
  }
  return ''
}

export function normalizeStockPick(row: Record<string, unknown>): A2uiStockPick | null {
  const symbol = normalizePickSymbol(row)
  if (!symbol) return null
  return {
    symbol,
    name: row.name ? String(row.name) : symbol,
    logoUrl: row.logoUrl ? String(row.logoUrl) : undefined,
    recommendation: row.recommendation ? String(row.recommendation) : undefined,
    token: row.token ? String(row.token) : undefined,
    exchange: row.exchange ? String(row.exchange) : undefined,
    score: typeof row.score === 'number' ? row.score : undefined,
  }
}

export function latestTopStockPicks(surfaces: A2uiSurfaceMessage[]): A2uiStockPick[] | null {
  for (let i = surfaces.length - 1; i >= 0; i--) {
    const surface = surfaces[i]
    if (surface.role !== 'agent' || surface.type !== 'a2ui_surface') continue
    for (let j = surface.components.length - 1; j >= 0; j--) {
      const component = surface.components[j]
      if (component.component !== 'TopStockPicks') continue
      const picks = Array.isArray(component.props.picks) ? component.props.picks : []
      const rows = picks
        .map(row => (row && typeof row === 'object' ? normalizeStockPick(row as Record<string, unknown>) : null))
        .filter((row): row is A2uiStockPick => Boolean(row?.symbol))
      if (rows.length) return rows.slice(0, 3)
    }
  }
  return null
}
