import { ExternalLink, Newspaper, RefreshCw } from 'lucide-react'

import { useCompanyNews } from '../../hooks/useCompanyNews'
import { formatNewsTimestamp } from '../../lib/companyNews'
import { showPlatformToast } from '../../lib/platform-toast'

type Props = {
  symbol: string
  className?: string
  variant?: 'card' | 'dock'
  showHeader?: boolean
}

export default function CompanyNewsPanel({
  symbol,
  className = '',
  variant = 'card',
  showHeader = true,
}: Props) {
  const { items, loading, refreshing, error, refresh } = useCompanyNews(symbol)

  const shellClass =
    variant === 'dock'
      ? 'flex min-h-0 flex-col overflow-hidden bg-secondary'
      : 'flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card/60'

  const handleRefresh = async () => {
    const result = await refresh()
    if (result == null) {
      showPlatformToast({
        message: 'Could not refresh news',
        variant: 'error',
      })
      return
    }
    showPlatformToast({
      message:
        result.addedCount > 0
          ? `${result.addedCount} new headline${result.addedCount === 1 ? '' : 's'} added`
          : 'No new headlines',
      variant: result.addedCount > 0 ? 'success' : 'default',
    })
  }

  const showList = !loading || items.length > 0

  return (
    <section
      className={`${shellClass} ${className}`}
      aria-label={`Company news for ${symbol}`}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {showHeader ? (
            <>
              <Newspaper className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                Company news
              </h3>
              <span className="truncate text-[10px] text-text-secondary/70">{symbol}</span>
            </>
          ) : (
            <span className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
              Headlines
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void handleRefresh()}
          disabled={loading || refreshing}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[10px] font-semibold text-text-primary transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
          title="Check for new headlines"
        >
          <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {loading && items.length === 0 ? (
          <p className="px-1 py-3 text-[11px] text-text-secondary">Loading news…</p>
        ) : error && items.length === 0 ? (
          <p className="px-1 py-3 text-[11px] text-red">{error}</p>
        ) : !showList || items.length === 0 ? (
          <p className="px-1 py-3 text-[11px] text-text-secondary">
            No recent news found. Finnhub covers North American stocks only.
          </p>
        ) : (
          <>
            {error ? (
              <p className="mb-2 rounded-md border border-red/30 bg-red/10 px-2 py-1 text-[10px] text-red">
                {error}
              </p>
            ) : null}
            <ul className="space-y-2">
              {items.map(item => (
                <li key={item.id}>
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group block rounded-md border border-transparent px-2 py-1.5 transition-colors hover:border-border hover:bg-secondary/40"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="line-clamp-2 text-[11px] font-medium leading-snug text-text-primary group-hover:text-accent">
                        {item.headline}
                      </p>
                      <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-text-secondary/50 group-hover:text-accent" />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-text-secondary">
                      {item.source ? <span>{item.source}</span> : null}
                      {item.datetime ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <time dateTime={new Date(item.datetime * 1000).toISOString()}>
                            {formatNewsTimestamp(item.datetime)}
                          </time>
                        </>
                      ) : null}
                    </div>
                    {item.summary ? (
                      <p className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-text-secondary/90">
                        {item.summary}
                      </p>
                    ) : null}
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  )
}
