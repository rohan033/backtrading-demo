export function edgarSearchUrl(symbol: string): string {
  const token = encodeURIComponent(symbol.trim().toUpperCase())
  return `https://www.sec.gov/edgar/search/#/q=${token}&sort=desc`
}

export function formatEdgarDraftLine(symbol: string, searchUrl?: string): string {
  const token = symbol.trim().toUpperCase()
  const url = searchUrl || edgarSearchUrl(token)
  return `Do a filing report on that symbol url: ${url}`
}

/** Prepended to the agent prompt so it uses web search / webfetch on the SEC link. */
export function formatEdgarAgentContext(symbol: string, searchUrl?: string): string {
  const token = symbol.trim().toUpperCase()
  const url = searchUrl || edgarSearchUrl(token)
  return [
    `[SEC EDGAR — ${token}]`,
    `Use web search and webfetch to review SEC filings at: ${url}`,
    'Produce a filing report (recent 10-K, 10-Q, 8-K and material disclosures).',
    '[/SEC EDGAR]',
  ].join('\n')
}

export function buildPromptWithEdgarContext(userText: string, symbol?: string): string {
  const text = userText.trim()
  const token = symbol?.trim().toUpperCase()
  if (!token) return text

  const url = edgarSearchUrl(token)
  if (text.includes(url)) return text

  const block = formatEdgarAgentContext(token)
  return text ? `${block}\n\n${text}` : block
}
