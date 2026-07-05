import type { A2uiStockPick, A2uiSurfaceMessage } from '@/lib/agentA2uiCatalog'
import { normalizeStockPick } from '@/lib/agentCandidatePicks'
import type { TradingSessionEvent } from '@/lib/tradingSessions'

function componentSurface(
  component: string,
  props: Record<string, unknown>,
  messageId: string,
): A2uiSurfaceMessage {
  return {
    type: 'a2ui_surface',
    messageId,
    role: 'agent',
    components: [{
      id: `${messageId}-root`,
      component: component as A2uiSurfaceMessage['components'][0]['component'],
      props,
    }],
  }
}

export function surfaceFromSessionEvent(event: TradingSessionEvent): A2uiSurfaceMessage | null {
  if (event.event_type === 'agent_a2ui_surface') {
    const payload = event.payload
    if (payload.type === 'a2ui_surface' && Array.isArray(payload.components)) {
      return payload as unknown as A2uiSurfaceMessage
    }
  }

  if (event.event_type === 'agent_picks') {
    const raw = Array.isArray(event.payload?.picks) ? event.payload.picks : []
    const picks = raw
      .map(row => (row && typeof row === 'object' ? normalizeStockPick(row as Record<string, unknown>) : null))
      .filter((row): row is A2uiStockPick => Boolean(row?.symbol))
    if (!picks.length) return null
    return componentSurface('TopStockPicks', { picks, showCharts: false }, `session-picks-${event.id}`)
  }

  return null
}

export function latestSessionPicks(events: TradingSessionEvent[]): A2uiStockPick[] | null {
  let picks: A2uiStockPick[] | null = null
  for (const event of events) {
    if (event.event_type === 'agent_picks') {
      const raw = Array.isArray(event.payload?.picks) ? event.payload.picks : []
      const rows = raw
        .map(row => (row && typeof row === 'object' ? normalizeStockPick(row as Record<string, unknown>) : null))
        .filter((row): row is A2uiStockPick => Boolean(row?.symbol))
      if (rows.length) picks = rows.slice(0, 3)
      continue
    }
    const surface = surfaceFromSessionEvent(event)
    if (!surface) continue
    for (const component of surface.components) {
      if (component.component !== 'TopStockPicks') continue
      const raw = Array.isArray(component.props.picks) ? component.props.picks : []
      const rows = raw
        .map(row => (row && typeof row === 'object' ? normalizeStockPick(row as Record<string, unknown>) : null))
        .filter((row): row is A2uiStockPick => Boolean(row?.symbol))
      if (rows.length) picks = rows.slice(0, 3)
    }
  }
  return picks
}

export function sessionA2uiSurfaces(events: TradingSessionEvent[]): A2uiSurfaceMessage[] {
  const surfaces: A2uiSurfaceMessage[] = []
  const seen = new Set<string>()
  for (const event of events) {
    const surface = surfaceFromSessionEvent(event)
    if (!surface) continue
    const key = `${surface.messageId}:${surface.components.map(c => c.component).join(',')}`
    if (seen.has(key)) continue
    seen.add(key)
    surfaces.push(surface)
  }
  return surfaces
}
