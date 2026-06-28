import { ExternalLink, Newspaper, RefreshCw } from 'lucide-react'

import { useCompanyNews } from '../../hooks/useCompanyNews'
import { formatNewsTimestamp } from '../../lib/companyNews'
import { showPlatformToast } from '../../lib/platform-toast'

type Props = {
  symbol: string
  className?: string
  variant?: 'card' | 'dock' | 'minimal'
  showHeader?: boolean
  filterText?: string
}

export default function CompanyNewsPanel({
  symbol,
  className = '',
  variant = 'card',
  showHeader = true,
  filterText = '',
}: Props) {
  const { items, loading, refreshing, error, refresh } = useCompanyNews(symbol)
  const normalizedFilter = filterText.trim().toLowerCase()
  const visibleItems = normalizedFilter
    ? items.filter(item =>
        [item.headline, item.summary, item.source]
          .filter(Boolean)
          .some(value => value.toLowerCase().includes(normalizedFilter)),
      )
    : items

  const shellClass =
    variant === 'minimal'
      ? 'ms-news-panel'
      : variant === 'dock'
      ? 'flex min-h-0 flex-col overflow-hidden bg-secondary'
      : 'flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card/60'
  const headerClass =
    variant === 'minimal'
      ? 'ms-news-panel__header'
      : 'flex shrink-0 items-center justify-between gap-2 border-b border-border/70 px-3 py-2'
  const titleClass =
    variant === 'minimal'
      ? 'ms-news-panel__title'
      : 'text-[11px] font-semibold uppercase tracking-wide text-text-secondary'
  const tickerClass =
    variant === 'minimal'
      ? 'ms-news-panel__topic'
      : 'truncate text-[10px] text-text-secondary/70'
  const buttonClass =
    variant === 'minimal'
      ? 'ms-news-panel__refresh'
      : 'inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[10px] font-semibold text-text-primary transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60'
  const bodyClass =
    variant === 'minimal'
      ? 'ms-news-panel__body'
      : 'min-h-0 flex-1 overflow-y-auto px-2 py-2'
  const itemClass =
    variant === 'minimal'
      ? 'ms-news-item'
      : 'group block rounded-md border border-transparent px-2 py-1.5 transition-colors hover:border-border hover:bg-secondary/40'
  const headlineClass =
    variant === 'minimal'
      ? 'ms-news-item__headline'
      : 'line-clamp-2 text-[11px] font-medium leading-snug text-text-primary group-hover:text-accent'
  const metaClass =
    variant === 'minimal'
      ? 'ms-news-item__meta'
      : 'mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-text-secondary'
  const summaryClass =
    variant === 'minimal'
      ? 'ms-news-item__summary'
      : 'mt-1 line-clamp-2 text-[10px] leading-relaxed text-text-secondary/90'
  const messageClass =
    variant === 'minimal'
      ? 'ms-news-panel__message'
      : 'px-1 py-3 text-[11px] text-text-secondary'

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
      <div className={headerClass}>
        <div className="ms-news-panel__heading">
          {showHeader ? (
            <>
              <Newspaper className="ms-news-panel__icon h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
              <h3 className={titleClass}>
                Company news
              </h3>
              <span className={tickerClass}>{symbol}</span>
            </>
          ) : (
            <span className={titleClass}>
              Headlines
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void handleRefresh()}
          disabled={loading || refreshing}
          className={buttonClass}
          title="Check for new headlines"
        >
          <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className={bodyClass}>
        {loading && items.length === 0 ? (
          <p className={messageClass}>Loading news…</p>
        ) : error && items.length === 0 ? (
          <p className={`${messageClass} ms-news-panel__message--error`}>{error}</p>
        ) : !showList || visibleItems.length === 0 ? (
          <p className={messageClass}>
            No recent news found. Finnhub covers North American stocks only.
          </p>
        ) : (
          <>
            {error ? (
              <p className="mb-2 rounded-md border border-red/30 bg-red/10 px-2 py-1 text-[10px] text-red">
                {error}
              </p>
            ) : null}
            <ul className={variant === 'minimal' ? 'ms-news-list' : 'space-y-2'}>
              {visibleItems.map(item => (
                <li key={item.id}>
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={itemClass}
                  >
                    <div className="ms-news-item__top">
                      <p className={headlineClass}>
                        {item.headline}
                      </p>
                      <ExternalLink className="ms-news-item__external mt-0.5 h-3 w-3 shrink-0 text-text-secondary/50 group-hover:text-accent" />
                    </div>
                    <div className={metaClass}>
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
                      <p className={summaryClass}>
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
