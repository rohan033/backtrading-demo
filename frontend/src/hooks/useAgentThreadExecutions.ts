import { useCallback, useEffect, useMemo, useState } from 'react'

import type { AgentThread, AgentThreadFocus } from '@/lib/agentThreads'
import {
  filterSessionExecutions,
  normalizeSymbol,
  resolveExecutionIdForAction,
  symbolFromAction,
  type ResearchSessionExecution,
} from '@/lib/researchActionLinks'
import type { AiResearchAction } from '@/lib/aiResearch'
import { isAgentStrategyRunning, resolveExecutionRuntimeStatus } from '@/lib/agentMonitorControl'

const CONTROL_API = '/api/control'

export type LinkedExecution = {
  executionId: string
  symbol?: string
  status?: string
  broker?: string
  accountEnv?: string
}

function focusFromAction(action: AiResearchAction, base?: AgentThreadFocus | null): AgentThreadFocus {
  const payload = action.payload || {}
  const symbol = String(payload.symbol || symbolFromAction(action) || '')
  return {
    symbol,
    token: payload.token ? String(payload.token) : base?.token ?? null,
    exchange: String(payload.exchange || base?.exchange || 'NSE'),
    broker: String(payload.broker || base?.broker || 'angel'),
    account_env: String(payload.account_env || base?.account_env || 'live'),
    close_price: payload.close_price != null ? Number(payload.close_price) : base?.close_price ?? null,
    long_percent: payload.long_percent != null ? Number(payload.long_percent) : base?.long_percent ?? null,
    short_percent: payload.short_percent != null ? Number(payload.short_percent) : base?.short_percent ?? null,
    initial_threshold:
      payload.initial_threshold != null ? Number(payload.initial_threshold) : base?.initial_threshold ?? null,
    max_available_capital:
      payload.max_available_capital != null
        ? Number(payload.max_available_capital)
        : base?.max_available_capital ?? null,
    execution_id: payload.execution_id ? String(payload.execution_id) : base?.execution_id ?? null,
  }
}

function focusFromEngineRow(
  row: ResearchSessionExecution,
  base?: AgentThreadFocus | null,
): AgentThreadFocus | null {
  const engine = row.engine || {}
  const config = engine.metadata?.execution_config || {}
  const executor = engine.metadata?.executor_payload || {}
  const symbol = String(engine.symbol || config.symbol || '').trim()
  if (!symbol) return base || null
  return {
    symbol,
    token: base?.token ?? null,
    exchange: String(config.exchange || base?.exchange || 'NSE'),
    broker: String(base?.broker || 'angel'),
    account_env: String(base?.account_env || 'live'),
    close_price: Number(executor.close_price ?? config.close_price ?? base?.close_price ?? 0) || null,
    long_percent: Number(config.long_percent ?? base?.long_percent ?? 0) || null,
    short_percent: Number(config.short_percent ?? base?.short_percent ?? 0) || null,
    initial_threshold: Number(config.initial_threshold ?? base?.initial_threshold ?? 0) || null,
    max_available_capital:
      Number(config.max_available_capital ?? base?.max_available_capital ?? 0) || null,
    execution_id: row.execution_id,
  }
}

export function useAgentThreadExecutions(thread: AgentThread | null, focus: AgentThreadFocus | null) {
  const [executions, setExecutions] = useState<LinkedExecution[]>([])
  const [linkedRows, setLinkedRows] = useState<ResearchSessionExecution[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!thread?.thread_id) {
      setExecutions([])
      setLinkedRows([])
      return
    }
    setLoading(true)
    try {
      const res = await fetch(`${CONTROL_API}/executions`)
      const data = await res.json()
      if (!data.status) return
      const linked = filterSessionExecutions(
        (data.data || []) as ResearchSessionExecution[],
        thread.thread_id,
      )
      setLinkedRows(linked)
      const claimed = new Set<string>()
      const fromActions: LinkedExecution[] = []
      for (const action of thread.actions || []) {
        const executionId = resolveExecutionIdForAction(action, linked, claimed)
        if (executionId) {
          claimed.add(executionId)
          const row = linked.find(item => item.execution_id === executionId)
          fromActions.push({
            executionId,
            symbol: String(action.payload?.symbol || row?.engine?.symbol || focus?.symbol || ''),
            status: resolveExecutionRuntimeStatus(row?.engine?.status, action.status),
            broker: String(action.payload?.broker || row?.engine?.broker || focus?.broker || ''),
            accountEnv: String(action.payload?.account_env || focus?.account_env || 'live'),
          })
        }
      }
      for (const row of linked) {
        if (claimed.has(row.execution_id)) continue
        fromActions.push({
          executionId: row.execution_id,
          symbol: String(row.engine?.symbol || focus?.symbol || ''),
          status: row.engine?.status,
          broker: String(focus?.broker || ''),
          accountEnv: String(focus?.account_env || 'live'),
        })
      }
      setExecutions(fromActions)
    } finally {
      setLoading(false)
    }
  }, [focus?.account_env, focus?.broker, focus?.symbol, thread])

  useEffect(() => {
    void refresh()
    if (!thread?.thread_id) return undefined
    const timer = window.setInterval(() => {
      void refresh()
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [refresh, thread?.thread_id])

  const primaryExecutionId = useMemo(() => {
    const running = executions.filter(row => isAgentStrategyRunning(row.status))
    if (running.length) {
      return running[running.length - 1].executionId
    }

    const actions = thread?.actions || []
    for (let i = actions.length - 1; i >= 0; i--) {
      const id = actions[i].payload?.execution_id
      if (id) return String(id)
    }

    if (focus?.execution_id) return focus.execution_id
    return executions[0]?.executionId || null
  }, [executions, focus?.execution_id, thread?.actions])

  const primaryExecution = useMemo(
    () => executions.find(row => row.executionId === primaryExecutionId) || null,
    [executions, primaryExecutionId],
  )

  const reconciledFocus = useMemo((): AgentThreadFocus | null => {
    if (!focus && !primaryExecutionId) return null

    const primaryRow = linkedRows.find(row => row.execution_id === primaryExecutionId)
    const execSymbol = normalizeSymbol(
      String(primaryExecution?.symbol || primaryRow?.engine?.symbol || ''),
    )
    const focusSymbol = normalizeSymbol(focus?.symbol || '')

    if (primaryExecutionId && execSymbol && execSymbol !== focusSymbol) {
      const actions = thread?.actions || []
      for (let i = actions.length - 1; i >= 0; i--) {
        const action = actions[i] as AiResearchAction
        const actionExecId = String(action.payload?.execution_id || '')
        const actionSymbol = normalizeSymbol(String(action.payload?.symbol || symbolFromAction(action) || ''))
        if (actionExecId === primaryExecutionId || actionSymbol === execSymbol) {
          return focusFromAction(action, focus)
        }
      }
      if (primaryRow) {
        return focusFromEngineRow(primaryRow, focus)
      }
    }

    return focus
  }, [focus, linkedRows, primaryExecution?.symbol, primaryExecutionId, thread?.actions])

  return {
    executions,
    primaryExecution,
    primaryExecutionId,
    reconciledFocus,
    linkedRows,
    loading,
    refresh,
  }
}
