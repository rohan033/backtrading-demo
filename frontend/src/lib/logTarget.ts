import type { LiveLogTarget } from '../hooks/useLiveLogStream'

export function buildLogTarget(input: {
  engineId: string | null | undefined
  executionId?: string | null
  label: string
  logFile?: string | null
  isControlled?: boolean
}): LiveLogTarget | null {
  const id = String(input.engineId || input.executionId || '').trim()
  if (!id) return null
  return {
    id,
    label: input.label,
    logFile: input.logFile ?? null,
    isControlled: input.isControlled ?? true,
    executionId: input.executionId ?? null,
  }
}
