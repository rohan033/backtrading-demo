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
    <header className="flex shrink-0 items-center justify-between border-b border-border bg-secondary px-4 py-3 sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border bg-card text-text-secondary transition-colors hover:text-text-primary"
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
          ) : (
            <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
        <h1 className="truncate text-base font-semibold">{meta.title}</h1>
        {meta.scope ? (
          <span className="hidden rounded border border-border bg-card px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-text-secondary sm:inline">
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
              className="rounded-md bg-accent px-4 py-2 text-[11px] font-bold text-white transition-opacity hover:opacity-90"
            >
              {meta.primaryAction.label}
            </Link>
          ) : (
            <button
              type="button"
              onClick={meta.primaryAction.onClick}
              className="rounded-md bg-accent px-4 py-2 text-[11px] font-bold text-white transition-opacity hover:opacity-90"
            >
              {meta.primaryAction.label}
            </button>
          )
        ) : null}
      </div>
    </header>
  )
}
