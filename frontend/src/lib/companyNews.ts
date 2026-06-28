export type CompanyNewsItem = {
  category: string
  datetime: number
  headline: string
  id: number
  image: string
  related: string
  source: string
  summary: string
  url: string
}

type CompanyNewsResponse = {
  status: boolean
  data: CompanyNewsItem[]
  meta?: {
    symbol: string
    from: string
    to: string
    count: number
  }
}

export function mergeCompanyNews(
  existing: CompanyNewsItem[],
  incoming: CompanyNewsItem[],
): { items: CompanyNewsItem[]; addedCount: number } {
  const byId = new Map<number, CompanyNewsItem>()
  for (const item of existing) byId.set(item.id, item)

  let addedCount = 0
  for (const item of incoming) {
    if (!byId.has(item.id)) addedCount += 1
    byId.set(item.id, item)
  }

  const items = [...byId.values()].sort((a, b) => (b.datetime || 0) - (a.datetime || 0))
  return { items, addedCount }
}

export async function fetchCompanyNews(symbol: string, days = 30): Promise<CompanyNewsItem[]> {
  const params = new URLSearchParams({
    symbol: symbol.trim(),
    days: String(days),
  })
  const res = await fetch(`/api/market/company-news?${params.toString()}`)
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = (await res.json()) as { detail?: string }
      if (body.detail) detail = body.detail
    } catch {
      // ignore parse errors
    }
    throw new Error(detail || 'Failed to load company news')
  }
  const payload = (await res.json()) as CompanyNewsResponse
  return Array.isArray(payload.data) ? payload.data : []
}

export function formatNewsTimestamp(unixSeconds: number): string {
  if (!unixSeconds) return ''
  const date = new Date(unixSeconds * 1000)
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
