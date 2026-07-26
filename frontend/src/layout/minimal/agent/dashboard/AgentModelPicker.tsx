import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  defaultParamsForModel,
  listCursorAgentModels,
  paramValueFor,
  setParamValue,
  type AgentModelParamSelection,
  type CursorAgentModel,
} from '@/lib/cursorAgentModels'

export type AgentModelPickerValue = {
  agentModelId: string
  agentModelParams: AgentModelParamSelection[]
}

type Props = {
  value: AgentModelPickerValue
  onChange: (value: AgentModelPickerValue) => void
  compact?: boolean
  layout?: 'stack' | 'inline'
  dense?: boolean
  disabled?: boolean
}

export function useAgentModelPickerState(initial?: Partial<AgentModelPickerValue>) {
  const [agentModelId, setAgentModelId] = useState(initial?.agentModelId || '')
  const [agentModelParams, setAgentModelParams] = useState<AgentModelParamSelection[]>(
    initial?.agentModelParams || [],
  )
  return {
    agentModelId,
    agentModelParams,
    setAgentModelId,
    setAgentModelParams,
    value: { agentModelId, agentModelParams },
    setValue: (next: AgentModelPickerValue) => {
      setAgentModelId(next.agentModelId)
      setAgentModelParams(next.agentModelParams)
    },
  }
}

export default function AgentModelPicker({
  value,
  onChange,
  compact = false,
  layout = 'stack',
  dense = false,
  disabled = false,
}: Props) {
  const [models, setModels] = useState<CursorAgentModel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const selectedModel = useMemo(
    () => models.find(model => model.id === value.agentModelId) || null,
    [models, value.agentModelId],
  )

  const activeVariantName = useMemo(() => {
    if (!selectedModel?.variants?.length) return ''
    const match = selectedModel.variants.find(variant =>
      variant.params?.every(param =>
        paramValueFor(value.agentModelParams, param.id) === String(param.value),
      ),
    )
    return match?.display_name || ''
  }, [selectedModel, value.agentModelParams])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    void listCursorAgentModels()
      .then(rows => {
        if (cancelled) return
        setModels(rows)
        setLoading(false)
        if (!rows.length) return
        const preferred =
          rows.find(model => model.id === value.agentModelId) ||
          rows.find(model => model.id === 'composer-2.5') ||
          rows.find(model => model.variants?.some(variant => variant.is_default)) ||
          rows[0]
        if (!value.agentModelId || !rows.some(model => model.id === value.agentModelId)) {
          onChange({
            agentModelId: preferred.id,
            agentModelParams: value.agentModelParams.length
              ? value.agentModelParams
              : defaultParamsForModel(preferred),
          })
        }
      })
      .catch(err => {
        if (cancelled) return
        setModels([])
        setLoading(false)
        const raw = err instanceof Error ? err.message : 'Failed to load models'
        setError(humanizeModelLoadError(raw))
      })
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- bootstrap once

  const handleModelChange = useCallback((modelId: string) => {
    const model = models.find(row => row.id === modelId) || null
    onChange({
      agentModelId: modelId,
      agentModelParams: defaultParamsForModel(model),
    })
  }, [models, onChange])

  const handleVariantSelect = useCallback((variantDisplayName: string) => {
    if (!selectedModel) return
    const variant = selectedModel.variants?.find(row => row.display_name === variantDisplayName)
    if (!variant) return
    onChange({
      agentModelId: value.agentModelId,
      agentModelParams: (variant.params || [])
        .filter(param => param.id && param.value)
        .map(param => ({ id: String(param.id), value: String(param.value) })),
    })
  }, [onChange, selectedModel, value.agentModelId])

  if (loading) {
    return <div className="ags-ms-empty">Loading models…</div>
  }

  const inline = layout === 'inline' || compact

  return (
    <div className={`ags-model${inline ? ' ags-model--inline' : ''}`}>
      {error ? (
        <p className="ags-model__warn" role="status">{error}</p>
      ) : null}
      <label className="ags-field">
        <span className="ags-field__label">
          {dense || inline ? 'Model' : 'Orchestrator model'}
          {!inline ? (
            <span className="ags-field__hint">
              Used by the main orchestrator, hunter, and session sub-agents.
            </span>
          ) : null}
        </span>
        <select
          className="ags-input ags-select"
          value={value.agentModelId}
          onChange={event => handleModelChange(event.target.value)}
          disabled={disabled || (!models.length && !error)}
        >
          {!models.length ? (
            <option value="">{error ? 'SDK default (bridge offline)' : 'No models available'}</option>
          ) : null}
          {models.map(model => (
            <option key={model.id} value={model.id}>
              {model.display_name || model.id}
            </option>
          ))}
        </select>
      </label>

      {!inline && selectedModel?.description ? (
        <p className="ags-field__hint ags-model__desc">{selectedModel.description}</p>
      ) : null}

      {selectedModel?.variants?.length ? (
        <label className="ags-field">
          <span className="ags-field__label">Preset</span>
          <select
            className="ags-input ags-select"
            value={activeVariantName}
            onChange={event => handleVariantSelect(event.target.value)}
            disabled={disabled}
          >
            <option value="">Custom</option>
            {selectedModel.variants.map(variant => (
              <option key={variant.display_name} value={variant.display_name}>
                {variant.display_name}{variant.is_default ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {selectedModel?.parameters?.length ? (
        <div className={inline ? 'ags-model__params ags-model__params--inline' : 'ags-model__params'}>
          {selectedModel.parameters.map(param => (
            <label key={param.id} className="ags-field">
              <span className="ags-field__label">{param.display_name || param.id}</span>
              <select
                className="ags-input ags-select"
                value={paramValueFor(value.agentModelParams, param.id)}
                onChange={event => {
                  onChange({
                    agentModelId: value.agentModelId,
                    agentModelParams: setParamValue(
                      value.agentModelParams,
                      param.id,
                      event.target.value,
                    ),
                  })
                }}
                disabled={disabled}
              >
                <option value="">—</option>
                {(param.values || []).map(option => (
                  <option key={option.value} value={option.value}>
                    {option.display_name || option.value}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function agentModelFromSessionConfig(
  config: Record<string, unknown> | undefined,
): AgentModelPickerValue {
  const agentModelId = typeof config?.agent_model === 'string' ? config.agent_model : ''
  const rawParams = config?.agent_model_params
  const agentModelParams = Array.isArray(rawParams)
    ? rawParams
        .filter((row): row is { id: string; value: string } =>
          Boolean(row && typeof row === 'object' && 'id' in row && 'value' in row),
        )
        .map(row => ({ id: String(row.id), value: String(row.value) }))
    : []
  return { agentModelId, agentModelParams }
}

export function agentModelDisplayLabel(
  models: CursorAgentModel[],
  modelId: string,
): string {
  if (!modelId) return 'SDK default'
  return models.find(model => model.id === modelId)?.display_name || modelId
}

function humanizeModelLoadError(message: string): string {
  if (/bridge request failed|connecterror|connection attempts failed/i.test(message)) {
    return (
      'Cursor agent bridge is unavailable — orchestrator will use the SDK default model. '
      + 'Ensure CURSOR_API_KEY is set and the control plane has finished starting via make dev.'
    )
  }
  if (/503|unavailable|control plane/i.test(message)) {
    return 'Control plane is still starting — model list unavailable; SDK default will be used.'
  }
  return message
}
