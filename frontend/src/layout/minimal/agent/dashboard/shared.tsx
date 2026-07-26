import type { ReactNode } from 'react'

export function money(value = 0, signed = false): string {
  const sign = signed && value !== 0 ? (value > 0 ? '+' : '-') : ''
  return `${sign}$${Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

export function compactMoney(value = 0): string {
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`
  if (abs >= 10_000) return `$${(value / 1_000).toFixed(1)}K`
  return money(value)
}

export function pnlClass(value = 0): string {
  return value > 0 ? 'ags-pos' : value < 0 ? 'ags-neg' : ''
}

export function humanizeAgent(name: string): string {
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase())
    .trim()
}

/** Deterministic short glyph for an agent/monitor row icon. */
export function agentGlyph(name: string): string {
  const key = name.toLowerCase()
  if (key.includes('orchestrator')) return '◆'
  if (key.includes('momentum')) return '↗'
  if (key.includes('news')) return '✦'
  if (key.includes('portfolio')) return '▤'
  if (key.includes('exit')) return '⊘'
  if (key.includes('risk')) return '⚠'
  if (key.includes('hunter')) return '⌖'
  if (key.includes('halt')) return '⏸'
  if (key.includes('rotation')) return '⟳'
  if (key.includes('session')) return '●'
  return '•'
}

export function Panel({
  title,
  count,
  className = '',
  bodyClassName = '',
  actions,
  children,
}: {
  title: string
  count?: ReactNode
  className?: string
  bodyClassName?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className={`ags-panel ags-wire-panel ${className}`}>
      <header className="ags-panel__head ags-wire-panel__head">
        <h2 className="ags-panel__title">{title}</h2>
        {count != null ? <span className="ags-panel__count">{count}</span> : null}
        {actions ? <div className="ags-wire-panel__actions">{actions}</div> : null}
      </header>
      <div className={`ags-panel__body ags-wire-panel__body ${bodyClassName}`}>{children}</div>
    </section>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="ags-empty ags-wire-empty">{children}</div>
}

export function ConfidenceBadge({ value }: { value: number | null | undefined }) {
  if (value == null || !Number.isFinite(value)) return null
  const pct = Math.round(value * 100)
  const tone = pct >= 70 ? 'high' : pct >= 40 ? 'mid' : 'low'
  return (
    <span className={`ags-conf ags-conf--${tone}`} title={`Confidence ${pct}%`}>
      {pct}%
    </span>
  )
}

export function StatusDot({ status }: { status: string }) {
  return <span className={`ags-mon-dot ags-mon-dot--${status}`} aria-hidden />
}
