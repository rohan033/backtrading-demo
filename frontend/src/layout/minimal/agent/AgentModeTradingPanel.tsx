import { useEffect, useMemo, useState } from 'react'

import AgentFocusChart from '@/components/charts/AgentFocusChart'
import { useAgentThreadExecutions } from '@/hooks/useAgentThreadExecutions'
import type { AgentThread } from '@/lib/agentThreads'
import type { HomeChartMonitorMarker } from '@/lib/homeChartMonitorMarkers'
import { buildAgentSymbolTabs, type AgentSymbolTab } from '@/lib/agentSymbolTabs'
import type { MarketStreamStatus } from '@/lib/useControlMarketStream'
import type { CandidateLiveFeed } from '@/hooks/useMultiSymbolLiveFeeds'
import type { A2uiStockPick } from '@/lib/agentA2uiCatalog'
import type { AgentThreadFocus } from '@/lib/agentThreads'

import MinimalTabPills from '../MinimalTabPills'
import AgentOrderDetailsCard from './AgentOrderDetailsCard'
import AgentPositionsTable from './AgentPositionsTable'
import AgentTradePnlTable from './AgentTradePnlTable'

type Props = {
  thread: AgentThread
  focus: AgentThreadFocus | null
  ltp: number | null
  streamStatus: MarketStreamStatus
  symbolTabs?: AgentSymbolTab[]
  candidatePicks?: A2uiStockPick[] | null
  feedsBySymbol?: Record<string, CandidateLiveFeed>
  broker?: string
  accountEnv?: string
  pnlRefreshKey?: number
  monitorMarkers?: HomeChartMonitorMarker[]
  monitorUserEnabled?: boolean
  executionStatus?: string | null
}

const IDLE_STREAM: MarketStreamStatus = { status: 'idle', label: '—', tone: 'muted' }

export default function AgentModeTradingPanel({
  thread,
  focus,
  ltp,
  streamStatus,
  symbolTabs: symbolTabsProp,
  candidatePicks = null,
  feedsBySymbol = {},
  broker = 'etoro',
  accountEnv = 'demo',
  pnlRefreshKey = 0,
  monitorMarkers = [],
  monitorUserEnabled = false,
  executionStatus = null,
}: Props) {
  const { executions } = useAgentThreadExecutions(thread, focus)

  const symbolTabs = useMemo(() => {
    if (symbolTabsProp?.length) return symbolTabsProp
    return buildAgentSymbolTabs({
      picks: candidatePicks,
      executions,
      primaryFocus: focus,
      feedsBySymbol,
      broker,
      accountEnv,
      singleLtp: ltp,
      singleStreamStatus: streamStatus,
    })
  }, [
    accountEnv,
    broker,
    candidatePicks,
    executions,
    feedsBySymbol,
    focus,
    ltp,
    streamStatus,
    symbolTabsProp,
  ])

  const [activeTabId, setActiveTabId] = useState(() => symbolTabs[0]?.id || '')

  useEffect(() => {
    if (!symbolTabs.length) return
    if (!symbolTabs.some(tab => tab.id === activeTabId)) {
      setActiveTabId(symbolTabs[0].id)
    }
  }, [activeTabId, symbolTabs])

  const activeTab = useMemo(() => {
    if (!symbolTabs.length) return null
    return symbolTabs.find(tab => tab.id === activeTabId) || symbolTabs[0]
  }, [activeTabId, symbolTabs])

  const activeFeed = useMemo((): CandidateLiveFeed | null => {
    if (!activeTab?.focus.symbol) return null
    const sym = activeTab.focus.symbol.toUpperCase()
    const root = activeTab.focus.symbol.split('-')[0].toUpperCase()
    return feedsBySymbol[sym] ?? feedsBySymbol[root] ?? null
  }, [activeTab, feedsBySymbol])

  const activeFocus = activeTab?.focus ?? focus
  const activeLtp = activeTab?.ltp ?? ltp
  const activeStream = activeTab?.streamStatus ?? streamStatus
  const activeExecutionId = activeTab?.executionId || focus?.execution_id || null
  const activeSymbol = activeFocus?.symbol || null

  const showOrder = Boolean(
    activeExecutionId ||
      thread.actions?.some(action => {
        const sym = String(action.payload?.symbol || '')
        return action.type.includes('strategy')
          && (!activeSymbol || sym.toUpperCase().startsWith(activeSymbol.split('-')[0].toUpperCase()))
      }),
  )

  const tabMarkers = useMemo(() => {
    if (!activeSymbol) return monitorMarkers
    const root = activeSymbol.split('-')[0].toUpperCase()
    return monitorMarkers.filter(marker => !marker.symbol || marker.symbol.toUpperCase().startsWith(root))
  }, [activeSymbol, monitorMarkers])

  if (!symbolTabs.length) {
    return (
      <section className="am-trading-panel am-trading-panel--empty">
        <div className="am-chat-empty">Waiting for the agent to pick symbols…</div>
      </section>
    )
  }

  return (
    <section className="am-trading-panel">
      {symbolTabs.length > 1 ? (
        <div className="am-trading-panel__tabs">
          <MinimalTabPills
            mode="state"
            tabs={symbolTabs.map(tab => ({
              id: tab.id,
              label: tab.label,
              active: tab.id === (activeTab?.id || ''),
              onClick: () => setActiveTabId(tab.id),
            }))}
          />
        </div>
      ) : null}
      {activeFocus?.symbol ? (
        <div className="am-trading-stack">
          <AgentFocusChart
            focus={activeFocus}
            ltp={activeLtp}
            streamStatus={activeStream || IDLE_STREAM}
            liveFeed={activeFeed}
            monitorMarkers={tabMarkers}
          />
          {showOrder ? (
            <AgentOrderDetailsCard
              focus={activeFocus}
              executionId={activeExecutionId}
              executionStatus={executionStatus}
            />
          ) : null}
          <AgentPositionsTable
            executions={executions}
            focusSymbol={activeFocus.symbol}
            symbolFilter={activeFocus.symbol}
            broker={activeFocus.broker}
            accountEnv={activeFocus.account_env}
            token={activeFocus.token}
            livePrice={activeLtp}
            pollMs={60_000}
            refreshKey={pnlRefreshKey}
            monitorActive={monitorUserEnabled}
          />
          <AgentTradePnlTable
            threadId={thread.thread_id}
            symbolFilter={activeFocus.symbol}
            refreshKey={pnlRefreshKey}
          />
        </div>
      ) : null}
    </section>
  )
}
