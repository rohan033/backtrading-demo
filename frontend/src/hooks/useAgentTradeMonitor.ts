import { useCallback, useEffect, useRef } from 'react'

import type { AgentThreadFocus } from '@/lib/agentThreads'
import { loadExecutionPositions, isOpenExecutionPosition } from '@/lib/executionPositions'
import { computeLivePnl } from '@/lib/positionPnl'

type Params = {
  threadId: string
  focus: AgentThreadFocus | null
  executionId: string | null
  livePrice?: number | null
  interactionMode: 'ask' | 'execute'
  sending: boolean
  sendMessage: (prompt: string) => Promise<boolean>
  enabled?: boolean
}

const MONITOR_INTERVAL_MS = 20_000

export function useAgentTradeMonitor({
  focus,
  executionId,
  livePrice = null,
  interactionMode,
  sending,
  sendMessage,
  enabled = true,
}: Params) {
  const lastPromptAtRef = useRef(0)

  const check = useCallback(async () => {
    if (!enabled || interactionMode !== 'execute' || !executionId || !focus || sending) return
    const now = Date.now()
    if (now - lastPromptAtRef.current < MONITOR_INTERVAL_MS) return

    const positions = await loadExecutionPositions({
      executorId: executionId,
      broker: focus.broker || 'etoro',
      accountEnv: focus.account_env || 'demo',
      symbol: focus.symbol,
      token: focus.token,
    })
    const open = positions.filter(isOpenExecutionPosition)
    if (!open.length) return

    const closePrice = Number(focus.close_price || 0)
    const targetPct = Number(focus.long_percent || 0)
    const stopPct = Number(focus.short_percent || 0)
    const ltp = livePrice ?? closePrice
    if (!closePrice || !ltp) return

    const movePct = ((ltp - closePrice) / closePrice) * 100
    const totalPnl = open
      .map(row => computeLivePnl(row as Parameters<typeof computeLivePnl>[0], ltp))
      .filter(Boolean)
      .reduce((sum, row) => sum + (row?.pnl ?? 0), 0)

    let reason: string | null = null
    if (targetPct > 0 && movePct >= targetPct) {
      reason = `Target zone reached (~${movePct.toFixed(2)}% vs ${targetPct}% target). Review hold vs exit.`
    } else if (stopPct > 0 && movePct <= -stopPct) {
      reason = `Stop zone reached (~${movePct.toFixed(2)}% vs -${stopPct}% stop). Review exit.`
    } else if (movePct < -stopPct * 0.6 && totalPnl < 0) {
      reason = `Thesis weakening (${movePct.toFixed(2)}% move, open PnL ${totalPnl.toFixed(2)}). Consider closing for best available profit.`
    }

    if (!reason) return

    lastPromptAtRef.current = now
    await sendMessage(
      `[Auto-monitor] ${reason} Symbol ${focus.symbol}. Open units: ${open.length}. `
      + 'Decide: hold, adjust, or close positions. Respond with TradeDecision only.',
    )
  }, [enabled, executionId, focus, interactionMode, livePrice, sendMessage, sending])

  useEffect(() => {
    if (!enabled || !executionId) return
    void check()
    const id = window.setInterval(() => { void check() }, MONITOR_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [check, enabled, executionId])
}
