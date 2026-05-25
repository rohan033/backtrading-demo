export type AiWorkflow = {
  id: string
  label: string
  prompt: string
}

const PENNY_STOCK_BASE = `Research penny stocks (roughly under $5) that could be near-term market gainers for quick-money scalp or momentum strategies on eToro or Angel One.

For each candidate, consider liquidity, relative volume, recent price momentum, spread/slippage risk, and whether the symbol is tradable in this platform.
Return a concise watchlist and a strategy outline compatible with this repo's execution config (entry trigger, capital sizing, partial exits).`

export const AI_WORKFLOWS: AiWorkflow[] = [
  {
    id: 'penny-overview',
    label: 'Penny stock gainers',
    prompt: `${PENNY_STOCK_BASE}

Compare 3%, 5%, 10%, 15%, and 20% take-profit templates and recommend which fits high-volatility penny names vs slightly slower movers.`,
  },
  {
    id: 'penny-tp-3',
    label: 'Penny · 3% TP',
    prompt: `${PENNY_STOCK_BASE}

Target a quick 3% take-profit with a tight stop-loss. Prioritize names with tight spreads and enough volume for fast in/out.`,
  },
  {
    id: 'penny-tp-5',
    label: 'Penny · 5% TP',
    prompt: `${PENNY_STOCK_BASE}

Target a 5% take-profit with a disciplined stop-loss. Balance momentum strength with realistic fill quality.`,
  },
  {
    id: 'penny-tp-10',
    label: 'Penny · 10% TP',
    prompt: `${PENNY_STOCK_BASE}

Target a 10% take-profit for stronger momentum setups. Flag which picks need wider stops vs which are still scalp-friendly.`,
  },
  {
    id: 'penny-tp-15',
    label: 'Penny · 15% TP',
    prompt: `${PENNY_STOCK_BASE}

Target a 15% take-profit swing on volatile penny gainers. Include catalyst or volume criteria that justify holding longer.`,
  },
  {
    id: 'penny-tp-20',
    label: 'Penny · 20% TP',
    prompt: `${PENNY_STOCK_BASE}

Target a 20% take-profit on high-conviction momentum names. Explain trade-offs vs lower TP scalps and suggest partial profit-taking.`,
  },
]
