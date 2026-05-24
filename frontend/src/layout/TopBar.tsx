import { Link, useLocation } from 'react-router-dom'

import { getPageMeta } from './page-meta'

export default function TopBar() {
  const location = useLocation()
  const meta = getPageMeta(location.pathname)

  return (
    <header className="flex shrink-0 items-center justify-between border-b border-border bg-secondary px-6 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <h1 className="truncate text-base font-semibold">{meta.title}</h1>
        {meta.scope ? (
          <span className="rounded border border-border bg-card px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-text-secondary">
            {meta.scope}
          </span>
        ) : null}
      </div>

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
    </header>
  )
}
