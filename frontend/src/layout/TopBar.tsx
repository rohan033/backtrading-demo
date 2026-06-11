import { Link, useLocation } from 'react-router-dom'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'

import { StopAllStrategiesButton } from '../components/StopAllStrategiesButton'
import { getPageMeta } from './page-meta'
import { useSidebar } from './sidebar-context'

export default function TopBar() {
  const location = useLocation()
  const meta = getPageMeta(location.pathname)
  const { collapsed, toggleCollapsed } = useSidebar()

  return (
    <header className="relative flex h-16 shrink-0 items-center justify-between border-b border-border bg-secondary/80 px-4 backdrop-blur-xl sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-card text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
          ) : (
            <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
        <h1 className="truncate font-display text-[18px] font-bold tracking-tightest text-text-primary">{meta.title}</h1>
        {meta.scope ? (
          <span className="hidden items-center rounded-full border border-accent/25 bg-accent/[0.08] px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.16em] text-accent sm:inline-flex">
            {meta.scope}
          </span>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <StopAllStrategiesButton />
        {meta.primaryAction ? (
          meta.primaryAction.to ? (
            <Link
              to={meta.primaryAction.to}
              className="rounded-md bg-accent px-4 py-2 text-[11.5px] font-bold text-primary shadow-[0_4px_14px_rgb(var(--c-accent)/0.3)] transition-transform hover:-translate-y-px hover:shadow-[0_6px_20px_rgb(var(--c-accent)/0.45)]"
            >
              {meta.primaryAction.label}
            </Link>
          ) : (
            <button
              type="button"
              onClick={meta.primaryAction.onClick}
              className="rounded-md bg-accent px-4 py-2 text-[11.5px] font-bold text-primary shadow-[0_4px_14px_rgb(var(--c-accent)/0.3)] transition-transform hover:-translate-y-px hover:shadow-[0_6px_20px_rgb(var(--c-accent)/0.45)]"
            >
              {meta.primaryAction.label}
            </button>
          )
        ) : null}
      </div>
    </header>
  )
}
