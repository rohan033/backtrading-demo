export type CursorModelParamValue = {
  value: string
  display_name: string
}

export type CursorModelParameter = {
  id: string
  display_name: string
  values: CursorModelParamValue[]
}

export type CursorModelVariant = {
  params: Array<{ id: string; value: string }>
  display_name: string
  description: string
  is_default: boolean
}

export type CursorAgentModel = {
  id: string
  display_name: string
  description: string
  parameters: CursorModelParameter[]
  variants: CursorModelVariant[]
}

export type AgentModelParamSelection = {
  id: string
  value: string
}

async function parseJson<T>(res: Response): Promise<T> {
  const text = await res.text()
  let body: {
    status?: boolean
    data?: T
    detail?: string
    message?: string
  } = {}
  if (text.trim()) {
    try {
      body = JSON.parse(text) as typeof body
    } catch {
      throw new Error(
        res.ok
          ? 'Invalid JSON from control plane'
          : 'Control plane unavailable — wait for make dev to finish starting, then refresh.',
      )
    }
  } else if (!res.ok) {
    throw new Error(
      'Control plane unavailable — wait for make dev to finish starting, then refresh.',
    )
  }
  if (!res.ok || body.status === false) {
    throw new Error(body.message || body.detail || res.statusText || 'Request failed')
  }
  return body.data as T
}

export async function listCursorAgentModels(): Promise<CursorAgentModel[]> {
  const res = await fetch('/api/control/cursor-agent/models')
  const data = await parseJson<CursorAgentModel[]>(res)
  return Array.isArray(data) ? data : []
}

/** Default param values for a model: prefer the default variant, else first value of each param. */
export function defaultParamsForModel(model: CursorAgentModel | null | undefined): AgentModelParamSelection[] {
  if (!model) return []
  const defaultVariant = model.variants?.find(v => v.is_default) ?? model.variants?.[0]
  if (defaultVariant?.params?.length) {
    return defaultVariant.params
      .filter(p => p.id && p.value)
      .map(p => ({ id: String(p.id), value: String(p.value) }))
  }
  const out: AgentModelParamSelection[] = []
  for (const param of model.parameters || []) {
    const first = param.values?.[0]
    if (param.id && first?.value) {
      out.push({ id: param.id, value: first.value })
    }
  }
  return out
}

export function paramValueFor(
  params: AgentModelParamSelection[],
  paramId: string,
): string {
  return params.find(p => p.id === paramId)?.value || ''
}

export function setParamValue(
  params: AgentModelParamSelection[],
  paramId: string,
  value: string,
): AgentModelParamSelection[] {
  const next = params.filter(p => p.id !== paramId)
  if (value) next.push({ id: paramId, value })
  return next
}
