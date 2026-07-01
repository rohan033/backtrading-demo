import { useMemo } from 'react'

import {
  getThreadFocus,
  type AgentThread,
  type AgentThreadFocus,
} from '@/lib/agentThreads'
import { symbolFromAction } from '@/lib/researchActionLinks'
import type { AiResearchAction } from '@/lib/aiResearch'

export function useAgentThreadFocus(thread: AgentThread | null): AgentThreadFocus | null {
  return useMemo(() => {
    const fromMeta = getThreadFocus(thread)
    if (fromMeta?.symbol) return fromMeta

    const actions = thread?.actions || []
    for (let i = actions.length - 1; i >= 0; i--) {
      const action = actions[i]
      const symbol = symbolFromAction(action as AiResearchAction)
      const payload = action.payload || {}
      if (symbol) {
        return {
          symbol: String(payload.symbol || symbol),
          token: payload.token ? String(payload.token) : null,
          exchange: String(payload.exchange || 'NSE'),
          broker: String(payload.broker || 'angel'),
          account_env: String(payload.account_env || 'live'),
          close_price: payload.close_price != null ? Number(payload.close_price) : null,
          long_percent: payload.long_percent != null ? Number(payload.long_percent) : null,
          short_percent: payload.short_percent != null ? Number(payload.short_percent) : null,
          initial_threshold:
            payload.initial_threshold != null ? Number(payload.initial_threshold) : null,
          max_available_capital:
            payload.max_available_capital != null
              ? Number(payload.max_available_capital)
              : null,
          execution_id: payload.execution_id ? String(payload.execution_id) : null,
        }
      }
    }
    return null
  }, [thread])
}

export function focusTickKey(focus: AgentThreadFocus): string {
  const broker = focus.broker || 'angel'
  const env = focus.account_env || 'live'
  const token = focus.token || focus.symbol || ''
  return `${broker}:${env}:${token}`
}
