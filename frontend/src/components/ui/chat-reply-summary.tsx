import { AlertTriangle, Sparkles, TrendingDown } from 'lucide-react'

import type { ChatReplySummary } from '@/lib/aiReplySummary'
import { cn } from '@/lib/utils'

type ChatReplySummaryProps = {
  summary: ChatReplySummary
  className?: string
}

function SummarySection({
  title,
  items,
  tone,
  icon: Icon,
}: {
  title: string
  items: string[]
  tone: 'high' | 'low' | 'caution'
  icon: typeof Sparkles
}) {
  if (!items.length) return null

  const toneClass =
    tone === 'high'
      ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-100'
      : tone === 'low'
        ? 'border-rose-500/35 bg-rose-500/10 text-rose-100'
        : 'border-amber-500/40 bg-amber-500/10 text-amber-100'

  const titleClass =
    tone === 'high'
      ? 'text-emerald-300'
      : tone === 'low'
        ? 'text-rose-300'
        : 'text-amber-300'

  return (
    <section className={cn('rounded-lg border px-3 py-2.5', toneClass)}>
      <div className={cn('mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide', titleClass)}>
        <Icon className="h-3.5 w-3.5 shrink-0" />
        {title}
      </div>
      <ul className="space-y-1 text-[13px] leading-snug text-text-primary/95">
        {items.map((item, index) => (
          <li key={`${title}-${index}`} className="flex gap-2">
            <span className="mt-[0.45rem] h-1 w-1 shrink-0 rounded-full bg-current opacity-70" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function ChatReplySummaryPanel({ summary, className }: ChatReplySummaryProps) {
  const hasContent =
    summary.highlights.length || summary.lowlights.length || summary.cautions.length
  if (!hasContent) return null

  return (
    <div
      className={cn(
        'mt-3 space-y-2 rounded-xl border border-border/70 bg-primary/40 p-2.5',
        className,
      )}
    >
      <p className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
        Quick summary
      </p>
      <div className="grid gap-2">
        <SummarySection title="Highlights" items={summary.highlights} tone="high" icon={Sparkles} />
        <SummarySection title="Lowlights" items={summary.lowlights} tone="low" icon={TrendingDown} />
        <SummarySection title="Cautions" items={summary.cautions} tone="caution" icon={AlertTriangle} />
      </div>
    </div>
  )
}

export default ChatReplySummaryPanel
