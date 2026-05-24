import type { ReactNode } from 'react'

export type PageMeta = {
  title: string
  scope?: string
  primaryAction?: {
    label: string
    to?: string
    onClick?: () => void
  }
}

const ROUTE_META: Record<string, PageMeta> = {
  '/dashboard': { title: 'Dashboard', scope: 'All strategies' },
  '/portfolio': { title: 'Portfolio', scope: 'Monitor' },
  '/watchlist': { title: 'Watchlist', scope: 'Monitor' },
  '/market': { title: 'Market', scope: 'Monitor' },
  '/trade/strategies': {
    title: 'Strategies',
    scope: 'Trade',
  },
  '/trade/strategies/new': { title: 'New strategy', scope: 'Trade' },
  '/trade/activity': { title: 'Activity', scope: 'Trade' },
  '/trade/charts': { title: 'Charts', scope: 'Trade' },
  '/learn/backtest': {
    title: 'Backtest Lab',
    scope: 'Learn',
    primaryAction: { label: 'Run backtest', to: '/learn/backtest' },
  },
  '/learn/simulation': { title: 'Simulation', scope: 'Learn' },
  '/learn/tools': { title: 'Tools', scope: 'Learn' },
  '/insights/performance': { title: 'Performance', scope: 'Insights' },
  '/insights/history': { title: 'History & Reports', scope: 'Insights' },
  '/settings': { title: 'Settings', scope: 'Platform' },
}

export function getPageMeta(pathname: string): PageMeta {
  if (ROUTE_META[pathname]) return ROUTE_META[pathname]

  if (pathname.startsWith('/trade/strategies/') && pathname !== '/trade/strategies/new') {
    return { title: 'Strategy', scope: 'Trade' }
  }

  return { title: 'Strategy Desk', scope: 'Platform' }
}

export function PlaceholderPage({
  title,
  description,
}: {
  title: string
  description: ReactNode
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center p-8 text-center">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-2 max-w-md text-sm text-text-secondary">{description}</p>
    </div>
  )
}
