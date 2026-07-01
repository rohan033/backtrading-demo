import { useMemo } from 'react'

import AgentFocusChart from '@/components/charts/AgentFocusChart'
import { useAgentThreadExecutions } from '@/hooks/useAgentThreadExecutions'
import type { AgentThread, AgentThreadFocus } from '@/lib/agentThreads'
import type { MarketStreamStatus } from '@/lib/useControlMarketStream'

import AgentOrderDetailsCard from './AgentOrderDetailsCard'
import AgentPositionsTable from './AgentPositionsTable'

type Props = {
  thread: AgentThread
  focus: AgentThreadFocus | null
  ltp: number | null
  streamStatus: MarketStreamStatus
}

export default function AgentModeTradingPanel({ thread, focus, ltp, streamStatus }: Props) {
  const { executions, primaryExecution, primaryExecutionId } = useAgentThreadExecutions(
    thread,
    focus,
  )

  const showOrder = Boolean(
    focus?.execution_id ||
      primaryExecutionId ||
      thread.actions?.some(action => action.type.includes('strategy') || action.payload?.symbol),
  )

  const executionStatus = useMemo(() => {
    const id = primaryExecutionId || focus?.execution_id
    if (!id) return primaryExecution?.status || null
    const action = thread.actions?.find(item => String(item.payload?.execution_id || '') === id)
    return action?.status || primaryExecution?.status || null
  }, [focus?.execution_id, primaryExecution?.status, primaryExecutionId, thread.actions])

  if (!focus?.symbol) {
    return (
      <section className="am-trading-panel am-trading-panel--empty">
        <div className="am-chat-empty">Waiting for the agent to pick a symbol…</div>
      </section>
    )
  }

  return (
    <section className="am-trading-panel">
      <div className="am-trading-stack">
        <AgentFocusChart focus={focus} ltp={ltp} streamStatus={streamStatus} />
        {showOrder ? (
          <AgentOrderDetailsCard
            focus={focus}
            executionId={primaryExecutionId}
            executionStatus={executionStatus}
          />
        ) : null}
        <AgentPositionsTable
          executions={executions}
          focusSymbol={focus.symbol}
          broker={focus.broker}
          accountEnv={focus.account_env}
          token={focus.token}
          livePrice={ltp}
          pollMs={3_000}
        />
      </div>
    </section>
  )
}
