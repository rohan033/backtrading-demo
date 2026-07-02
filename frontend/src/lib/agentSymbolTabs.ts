import type { A2uiStockPick } from '@/lib/agentA2uiCatalog'
import type { LinkedExecution } from '@/hooks/useAgentThreadExecutions'
import type { AgentThreadFocus } from '@/lib/agentThreads'
import type { CandidateLiveFeed } from '@/hooks/useMultiSymbolLiveFeeds'

export type AgentSymbolTab = {
  id: string
  label: string
  focus: AgentThreadFocus
  executionId: string | null
  ltp: number | null
  streamStatus: CandidateLiveFeed['streamStatus'] | null
}

function tabId(symbol: string): string {
  return symbol.trim().toUpperCase().split('-')[0]
}

function focusFromPick(
  pick: A2uiStockPick,
  feed: CandidateLiveFeed | undefined,
  broker: string,
  accountEnv: string,
): AgentThreadFocus {
  return feed?.focus ?? {
    symbol: pick.symbol,
    token: pick.token ?? null,
    exchange: pick.exchange || (broker === 'etoro' ? 'ETORO' : 'NSE'),
    broker,
    account_env: accountEnv,
  }
}

export function buildAgentSymbolTabs(params: {
  picks?: A2uiStockPick[] | null
  executions: LinkedExecution[]
  primaryFocus: AgentThreadFocus | null
  feedsBySymbol?: Record<string, CandidateLiveFeed>
  broker: string
  accountEnv: string
  singleLtp?: number | null
  singleStreamStatus?: CandidateLiveFeed['streamStatus'] | null
}): AgentSymbolTab[] {
  const {
    picks,
    executions,
    primaryFocus,
    feedsBySymbol = {},
    broker,
    accountEnv,
    singleLtp = null,
    singleStreamStatus = null,
  } = params

  const byId = new Map<string, AgentSymbolTab>()

  const upsert = (
    symbol: string,
    focus: AgentThreadFocus,
    executionId: string | null,
    ltp: number | null,
    streamStatus: AgentSymbolTab['streamStatus'],
  ) => {
    const id = tabId(symbol)
    if (!id) return
    const existing = byId.get(id)
    byId.set(id, {
      id,
      label: id,
      focus: { ...focus, symbol, execution_id: executionId || focus.execution_id || existing?.executionId || null },
      executionId: executionId || existing?.executionId || focus.execution_id || null,
      ltp: ltp ?? existing?.ltp ?? null,
      streamStatus: streamStatus || existing?.streamStatus || null,
    })
  }

  for (const row of executions) {
    const sym = String(row.symbol || '').trim()
    if (!sym) continue
    upsert(
      sym,
      {
        symbol: sym,
        broker: row.broker || broker,
        account_env: row.accountEnv || accountEnv,
        execution_id: row.executionId,
      },
      row.executionId,
      feedsBySymbol[sym.toUpperCase()]?.ltp ?? singleLtp,
      feedsBySymbol[sym.toUpperCase()]?.streamStatus ?? singleStreamStatus,
    )
  }

  if (primaryFocus?.symbol) {
    const sym = primaryFocus.symbol
    upsert(
      sym,
      primaryFocus,
      primaryFocus.execution_id || executions.find(e => e.symbol === sym)?.executionId || null,
      feedsBySymbol[sym.toUpperCase()]?.ltp ?? singleLtp,
      feedsBySymbol[sym.toUpperCase()]?.streamStatus ?? singleStreamStatus,
    )
  }

  for (const pick of picks ?? []) {
    if (!pick.symbol) continue
    const feed = feedsBySymbol[pick.symbol.toUpperCase()]
    const exec = executions.find(row => tabId(row.symbol || '') === tabId(pick.symbol))
    upsert(
      pick.symbol,
      focusFromPick(pick, feed, broker, accountEnv),
      exec?.executionId || null,
      feed?.ltp ?? null,
      feed?.streamStatus ?? null,
    )
  }

  return [...byId.values()]
}
