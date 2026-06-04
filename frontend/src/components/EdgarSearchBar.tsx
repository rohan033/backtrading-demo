import { useMemo, useState } from 'react'
import { ExternalLink } from 'lucide-react'

import { edgarSearchUrl } from '@/lib/edgar'
import { cn } from '@/lib/utils'

type EdgarSearchBarProps = {
  className?: string
  onSymbolChange?: (symbol: string) => void
  onEdgarSearchClick?: (symbol: string, searchUrl: string) => void
}

export function EdgarSearchBar({
  className,
  onSymbolChange,
  onEdgarSearchClick,
}: EdgarSearchBarProps) {
  const [symbol, setSymbol] = useState('')

  const trimmed = symbol.trim().toUpperCase()
  const searchUrl = useMemo(() => (trimmed ? edgarSearchUrl(trimmed) : ''), [trimmed])

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <label className="sr-only" htmlFor="edgar-symbol">
        EDGAR symbol
      </label>
      <span className="text-[10px] font-medium uppercase tracking-wide text-text-secondary">SEC EDGAR</span>
      <input
        id="edgar-symbol"
        type="text"
        value={symbol}
        onChange={event => {
          const next = event.target.value.toUpperCase()
          setSymbol(next)
          onSymbolChange?.(next.trim())
        }}
        placeholder="Symbol"
        maxLength={12}
        className="h-8 w-24 rounded-lg border border-border bg-primary px-2 font-mono text-xs uppercase text-text-primary outline-none placeholder:text-text-secondary focus:border-accent/60"
      />
      <a
        href={searchUrl || '#'}
        target="_blank"
        rel="noopener noreferrer"
        onClick={event => {
          if (!trimmed) {
            event.preventDefault()
            return
          }
          onEdgarSearchClick?.(trimmed, searchUrl)
        }}
        className={cn(
          'inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors',
          trimmed
            ? 'border-sky-400/40 bg-sky-500/15 text-sky-200 hover:bg-sky-500/25'
            : 'pointer-events-none border-border/50 bg-primary/40 text-text-secondary opacity-50',
        )}
      >
        <ExternalLink className="h-3.5 w-3.5" />
        EDGAR search
      </a>
      {trimmed ? (
        <span className="text-[11px] text-text-secondary/80">Agent will use web search on the SEC link</span>
      ) : null}
    </div>
  )
}

export default EdgarSearchBar
