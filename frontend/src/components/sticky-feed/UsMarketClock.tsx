import { Clock3 } from 'lucide-react'

import { useUsMarketClock } from '../../hooks/useUsMarketClock'
import { usMarketSessionLabel } from '../../lib/usMarketClock'

const SESSION_DOT_CLASS: Record<string, string> = {
  open: 'bg-green shadow-[0_0_8px_rgb(var(--c-up)/0.65)]',
  pre: 'bg-amber-400 shadow-[0_0_8px_rgb(251_191_36/0.55)]',
  after: 'bg-amber-400 shadow-[0_0_8px_rgb(251_191_36/0.55)]',
  closed: 'bg-text-secondary/40',
}

const SESSION_TEXT_CLASS: Record<string, string> = {
  open: 'text-green',
  pre: 'text-amber-300',
  after: 'text-amber-300',
  closed: 'text-text-secondary',
}

export default function UsMarketClock() {
  const { time, session } = useUsMarketClock()

  return (
    <div
      className="inline-flex items-center gap-2 rounded-md border border-border/80 bg-card/70 px-2.5 py-1 shadow-sm"
      title={`US market time (${usMarketSessionLabel(session)})`}
    >
      <Clock3 className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-secondary">
        US
      </span>
      <time
        dateTime={time}
        className="font-mono text-sm font-bold tabular-nums tracking-[0.08em] text-text-primary"
      >
        {time}
      </time>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary/80">
        ET
      </span>
      <span
        className={`hidden h-1.5 w-1.5 shrink-0 rounded-full sm:inline-block ${SESSION_DOT_CLASS[session]}`}
        aria-hidden="true"
      />
      <span className={`hidden text-[10px] font-medium sm:inline ${SESSION_TEXT_CLASS[session]}`}>
        {usMarketSessionLabel(session)}
      </span>
    </div>
  )
}
