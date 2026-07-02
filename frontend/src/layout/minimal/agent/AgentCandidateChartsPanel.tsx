import AgentCandidateMiniChart from '@/components/charts/AgentCandidateMiniChart'
import type { CandidateLiveFeed } from '@/hooks/useMultiSymbolLiveFeeds'
import { normalizeStockPick } from '@/lib/agentCandidatePicks'
import type { A2uiStockPick } from '@/lib/agentA2uiCatalog'
import type { WatchlistBroker } from '@/lib/watchlistBrokers'

type Props = {
  picks: A2uiStockPick[]
  broker: WatchlistBroker
  accountEnv: 'live' | 'demo'
  liveFeedsBySymbol?: Record<string, CandidateLiveFeed>
  onPick: (symbol: string) => void
}

export default function AgentCandidateChartsPanel({
  picks,
  broker,
  accountEnv,
  liveFeedsBySymbol = {},
  onPick,
}: Props) {
  return (
    <section className="am-candidate-panel">
      <div className="am-column-header">Compare candidates</div>
      <div className="am-candidate-panel__body">
        {picks.slice(0, 3).map((pick, index) => {
          const normalized = normalizeStockPick(pick as unknown as Record<string, unknown>) || pick
          const symbol = String(normalized.symbol || '')
          const name = String(normalized.name || symbol)
          const recommendation = String(normalized.recommendation || '')
          const displaySymbol = symbol.split('-')[0] || name.split(' ')[0] || `Pick ${index + 1}`
          return (
            <button
              type="button"
              key={`${symbol || displaySymbol}-${index}`}
              className="am-candidate-panel__card"
              onClick={() => onPick(symbol)}
            >
              <div className="am-candidate-panel__head">
                <span className="am-candidate-panel__symbol">{displaySymbol}</span>
                <span className="am-candidate-panel__name">{name}</span>
              </div>
              <AgentCandidateMiniChart
                symbol={symbol}
                token={normalized.token}
                exchange={normalized.exchange}
                broker={broker}
                accountEnv={accountEnv}
                height={140}
                liveFeed={liveFeedsBySymbol[symbol.toUpperCase()]}
              />
              {recommendation ? (
                <p className="am-candidate-panel__rec">{recommendation}</p>
              ) : null}
              <span className="am-candidate-panel__cta">Select to trade</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
