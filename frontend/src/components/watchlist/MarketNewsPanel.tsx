import { ExternalLink, Globe2, RefreshCw } from 'lucide-react'

import { useMarketNews } from '../../hooks/useMarketNews'
import { formatNewsTimestamp } from '../../lib/companyNews'
import { MARKET_NEWS_CATEGORIES } from '../../lib/marketNews'
import { showPlatformToast } from '../../lib/platform-toast'

type Props = {
  className?: string
  variant?: 'dock' | 'minimal'
  filterText?: string
}

export default function MarketNewsPanel({
  className = '',
  variant = 'dock',
  filterText = '',
}: Props) {
  const { category, setCategory, items, loading, refreshing, error, refresh } = useMarketNews()
  const normalizedFilter = filterText.trim().toLowerCase()
  const visibleItems = normalizedFilter
    ? items.filter(item =>
        [item.headline, item.summary, item.source, item.category]
          .filter(Boolean)
          .some(value => value.toLowerCase().includes(normalizedFilter)),
      )
    : items
  const minimal = variant === 'minimal'
  const shellClass = minimal
    ? 'ms-news-panel'
    : 'flex min-h-0 flex-col overflow-hidden bg-secondary'
  const headerClass = minimal
    ? 'ms-news-panel__header'
    : 'flex shrink-0 items-center justify-between gap-2 border-b border-border/70 px-3 py-2'
  const titleClass = minimal
    ? 'ms-news-panel__title'
    : 'text-[10px] font-semibold uppercase tracking-wide text-text-secondary'
  const selectClass = minimal
    ? 'ms-news-panel__select'
    : 'h-7 max-w-[6.5rem] cursor-pointer rounded-md border border-border bg-card px-1.5 text-[10px] font-semibold text-text-primary outline-none focus:border-accent/40'
  const buttonClass = minimal
    ? 'ms-news-panel__refresh'
    : 'inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[10px] font-semibold text-text-primary transition-colors hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60'
  const subheaderClass = minimal
    ? 'ms-news-panel__subheader'
    : 'shrink-0 border-b border-border/50 px-4 py-1.5'
  const bodyClass = minimal
    ? 'ms-news-panel__body'
    : 'min-h-0 flex-1 overflow-y-auto px-2 py-2'
  const itemClass = minimal
    ? 'ms-news-item'
    : 'group block rounded-md border border-transparent px-2 py-1.5 transition-colors hover:border-border hover:bg-secondary/40'
  const headlineClass = minimal
    ? 'ms-news-item__headline'
    : 'line-clamp-2 text-[11px] font-medium leading-snug text-text-primary group-hover:text-accent'
  const metaClass = minimal
    ? 'ms-news-item__meta'
    : 'mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-text-secondary'
  const categoryClass = minimal
    ? 'ms-news-item__tag'
    : 'rounded bg-muted/30 px-1 py-0.5 text-[9px] uppercase tracking-wide'
  const summaryClass = minimal
    ? 'ms-news-item__summary'
    : 'mt-1 line-clamp-2 text-[10px] leading-relaxed text-text-secondary/90'
  const messageClass = minimal
    ? 'ms-news-panel__message'
    : 'px-1 py-3 text-[11px] text-text-secondary'

  const handleRefresh = async () => {
    const result = await refresh()
    if (result == null) {
      showPlatformToast({
        message: 'Could not refresh market news',
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

  const categoryLabel =
    MARKET_NEWS_CATEGORIES.find(option => option.id === category)?.label ?? category

  return (
    <section
      className={`${shellClass} ${className}`}
      aria-label="Market news"
    >
      <div className={headerClass}>
        <div className="ms-news-panel__heading">
          <Globe2 className="ms-news-panel__icon h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
          <span className={titleClass}>
            Market news
          </span>
          <label className="sr-only" htmlFor="market-news-category">
            Market news category
          </label>
          <select
            id="market-news-category"
            value={category}
            onChange={event => setCategory(event.target.value as typeof category)}
            className={selectClass}
          >
            {MARKET_NEWS_CATEGORIES.map(option => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
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

      <div className={subheaderClass}>
        <p className={minimal ? '' : 'text-[10px] text-text-secondary/80'}>
          {categoryLabel} headlines from Finnhub
        </p>
      </div>

      <div className={bodyClass}>
        {loading && items.length === 0 ? (
          <p className={messageClass}>Loading market news…</p>
        ) : error && items.length === 0 ? (
          <p className={`${messageClass} ms-news-panel__message--error`}>{error}</p>
        ) : visibleItems.length === 0 ? (
          <p className={messageClass}>No market news found.</p>
        ) : (
          <>
            {error ? (
              <p className="mb-2 rounded-md border border-red/30 bg-red/10 px-2 py-1 text-[10px] text-red">
                {error}
              </p>
            ) : null}
            <ul className={minimal ? 'ms-news-list' : 'space-y-2'}>
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
                      {item.category ? (
                        <span className={categoryClass}>
                          {item.category}
                        </span>
                      ) : null}
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
