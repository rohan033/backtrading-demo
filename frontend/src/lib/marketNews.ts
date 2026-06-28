import { mergeCompanyNews, type CompanyNewsItem } from './companyNews'

export type MarketNewsCategory = 'general' | 'forex' | 'crypto' | 'merger'

export type MarketNewsItem = CompanyNewsItem

export const MARKET_NEWS_CATEGORIES: { id: MarketNewsCategory; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'forex', label: 'Forex' },
  { id: 'crypto', label: 'Crypto' },
  { id: 'merger', label: 'M&A' },
]

const CATEGORY_STORAGE_KEY = 'market-news-category-v1'

type MarketNewsResponse = {
  status: boolean
  data: MarketNewsItem[]
  meta?: {
    category: string
    minId: number
    count: number
  }
}

export function loadMarketNewsCategory(): MarketNewsCategory {
  try {
    const raw = localStorage.getItem(CATEGORY_STORAGE_KEY)
    if (raw && MARKET_NEWS_CATEGORIES.some(option => option.id === raw)) {
      return raw as MarketNewsCategory
    }
  } catch {
    // ignore storage errors
  }
  return 'general'
}

export function saveMarketNewsCategory(category: MarketNewsCategory): void {
  try {
    localStorage.setItem(CATEGORY_STORAGE_KEY, category)
  } catch {
    // ignore storage errors
  }
}

export function mergeMarketNews(
  existing: MarketNewsItem[],
  incoming: MarketNewsItem[],
): { items: MarketNewsItem[]; addedCount: number } {
  return mergeCompanyNews(existing, incoming)
}

export async function fetchMarketNews(
  category: MarketNewsCategory,
  minId = 0,
  refresh = false,
): Promise<MarketNewsItem[]> {
  const params = new URLSearchParams({
    category,
    minId: String(minId),
  })
  if (refresh) params.set('refresh', 'true')
  const res = await fetch(`/api/market/market-news?${params.toString()}`)
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = (await res.json()) as { detail?: string }
      if (body.detail) detail = body.detail
    } catch {
      // ignore parse errors
    }
    throw new Error(detail || 'Failed to load market news')
  }
  const payload = (await res.json()) as MarketNewsResponse
  return Array.isArray(payload.data) ? payload.data : []
}

export function maxMarketNewsId(items: MarketNewsItem[]): number {
  if (!items.length) return 0
  return items.reduce((max, item) => Math.max(max, item.id || 0), 0)
}
