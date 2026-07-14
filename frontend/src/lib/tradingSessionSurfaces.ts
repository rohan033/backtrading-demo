import type { A2uiStockPick, A2uiSurfaceMessage } from '@/lib/agentA2uiCatalog'
import { normalizeStockPick } from '@/lib/agentCandidatePicks'
import { surfacesFromAssistantText } from '@/lib/agentA2uiHydrate'
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

function setupFormToSummary(props: Record<string, unknown>): Record<string, unknown> {
  const symbol = String(props.symbol || '').split('-')[0]
  return {
    symbol,
    entry_price: props.close_price ?? props.entry_price,
    long_percent: props.long_percent,
    short_percent: props.short_percent,
    capital: props.max_available_capital ?? props.capital,
    broker: props.broker,
    account_env: props.account_env,
    status: props.status ?? 'auto-deploying',
  }
}

/** Trading sessions auto-deploy — convert interactive setup forms to read-only summaries. */
export function normalizeAutonomousSessionSurface(surface: A2uiSurfaceMessage): A2uiSurfaceMessage | null {
  const components = surface.components
    .filter(c => c.component !== 'ButtonRow')
    .map(c => {
      if (c.component !== 'StrategySetupForm') return c
      return {
        ...c,
        component: 'StrategySummary' as A2uiSurfaceMessage['components'][0]['component'],
        props: setupFormToSummary(c.props as Record<string, unknown>),
      }
    })
  if (!components.length) return null
  return { ...surface, components }
}

function normalizeSurfaces(surfaces: A2uiSurfaceMessage[]): A2uiSurfaceMessage[] {
  return surfaces
    .map(normalizeAutonomousSessionSurface)
    .filter((row): row is A2uiSurfaceMessage => Boolean(row))
}

export function surfaceFromSessionEvent(event: TradingSessionEvent): A2uiSurfaceMessage | null {
  if (event.event_type === 'agent_a2ui_surface') {
    const payload = event.payload
    if (payload.type === 'a2ui_surface' && Array.isArray(payload.components)) {
      return normalizeAutonomousSessionSurface(payload as unknown as A2uiSurfaceMessage)
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

  if (event.event_type === 'agent_text') {
    const text = String(event.payload?.text || '').trim()
    if (!text) return null
    const surfaces = normalizeSurfaces(surfacesFromAssistantText(text, `session-text-${event.id}`))
    return surfaces[0] ?? null
  }

  return null
}

export function surfacesFromSessionEvent(event: TradingSessionEvent): A2uiSurfaceMessage[] {
  if (event.event_type === 'agent_a2ui_surface') {
    const surface = surfaceFromSessionEvent(event)
    return surface ? [surface] : []
  }

  if (event.event_type === 'agent_picks') {
    const surface = surfaceFromSessionEvent(event)
    return surface ? [surface] : []
  }

  if (event.event_type === 'agent_text') {
    const text = String(event.payload?.text || '').trim()
    if (!text) return []
    return normalizeSurfaces(surfacesFromAssistantText(text, `session-text-${event.id}`))
  }

  return []
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
    for (const surface of surfacesFromSessionEvent(event)) {
      for (const component of surface.components) {
        if (component.component !== 'TopStockPicks') continue
        const raw = Array.isArray(component.props.picks) ? component.props.picks : []
        const rows = raw
          .map(row => (row && typeof row === 'object' ? normalizeStockPick(row as Record<string, unknown>) : null))
          .filter((row): row is A2uiStockPick => Boolean(row?.symbol))
        if (rows.length) picks = rows.slice(0, 3)
      }
    }
  }
  return picks
}

export function sessionA2uiSurfaces(events: TradingSessionEvent[]): A2uiSurfaceMessage[] {
  const surfaces: A2uiSurfaceMessage[] = []
  const seen = new Set<string>()
  for (const event of events) {
    for (const surface of surfacesFromSessionEvent(event)) {
      const key = `${surface.messageId}:${surface.components.map(c => c.component).join(',')}`
      if (seen.has(key)) continue
      seen.add(key)
      surfaces.push(surface)
    }
  }
  return surfaces
}

/** Surfaces emitted during a single agent run (events between run started/finished). */
export function sessionSurfacesForRun(events: TradingSessionEvent[], runId: string): A2uiSurfaceMessage[] {
  const surfaces: A2uiSurfaceMessage[] = []
  const seen = new Set<string>()
  let inRun = false

  for (const event of events) {
    if (event.event_type === 'agent_run_started') {
      const id = String(event.payload?.run_id || event.payload?.runId || '')
      inRun = id === runId
      continue
    }
    if (!inRun) continue

    if (event.event_type === 'agent_run_finished') {
      const id = String(event.payload?.run_id || event.payload?.runId || '')
      if (id === runId) break
    }

    if (event.event_type !== 'agent_a2ui_surface' && event.event_type !== 'agent_text') continue

    for (const surface of surfacesFromSessionEvent(event)) {
      if (surface.components.some(c => c.component === 'TopStockPicks')) continue
      const key = `${surface.messageId}:${surface.components.map(c => c.component).join(',')}`
      if (seen.has(key)) continue
      seen.add(key)
      surfaces.push(surface)
    }
  }
  return surfaces
}

const FENCE_START_RE = /```(?:json|a2ui)?\s*/gi

export function stripAgentTextFences(text: string): string {
  let cleaned = text
  const re = new RegExp(FENCE_START_RE.source, FENCE_START_RE.flags)
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const bodyStart = match.index + match[0].length
    const endIdx = text.indexOf('```', bodyStart)
    if (endIdx === -1) continue
    cleaned = cleaned.replace(text.slice(match.index, endIdx + 3), '')
  }
  return cleaned.replace(/\n{3,}/g, '\n\n').trim()
}
