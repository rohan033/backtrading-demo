import type { ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { cn } from '@/lib/utils'

type Props = {
  side: 'left' | 'right'
  headerClass: string
  collapsed: boolean
  onToggleCollapsed: () => void
  header: ReactNode
  children: ReactNode
  widthClass?: string
  ariaLabel: string
}

export default function MinimalDrawer({
  side,
  headerClass,
  collapsed,
  onToggleCollapsed,
  header,
  children,
  widthClass = 'w-[220px]',
  ariaLabel,
}: Props) {
  const CollapseIcon = side === 'left' ? ChevronLeft : ChevronRight
  const ExpandIcon = side === 'left' ? ChevronRight : ChevronLeft

  if (collapsed) {
    return (
      <aside
        className={cn(
          'flex shrink-0 flex-col m-border border-y-0',
          side === 'left' ? 'border-l-0' : 'border-r-0',
          'w-10',
        )}
        aria-label={ariaLabel}
      >
        <div className={cn('flex h-12 items-center justify-center', headerClass, 'm-border border-x-0 border-t-0')}>
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="m-collapse-btn grid h-7 w-7 place-items-center rounded-full shadow-sm"
            title={`Expand ${ariaLabel}`}
            aria-label={`Expand ${ariaLabel}`}
          >
            <ExpandIcon className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="m-panel-body min-h-0 flex-1" />
      </aside>
    )
  }

  return (
    <aside
      className={cn(
        'flex shrink-0 flex-col m-border border-y-0',
        side === 'left' ? 'border-l-0' : 'border-r-0',
        widthClass,
      )}
      aria-label={ariaLabel}
    >
      <div
        className={cn(
          'flex h-12 shrink-0 items-center gap-2 px-2',
          headerClass,
          'm-border border-x-0 border-t-0',
          side === 'right' ? 'justify-between' : '',
        )}
      >
        {side === 'left' ? (
          <>
            <button
              type="button"
              onClick={onToggleCollapsed}
              className="m-collapse-btn grid h-7 w-7 shrink-0 place-items-center rounded-full shadow-sm"
              title={`Collapse ${ariaLabel}`}
              aria-label={`Collapse ${ariaLabel}`}
            >
              <CollapseIcon className="h-3.5 w-3.5" />
            </button>
            {header}
          </>
        ) : (
          <>
            {header}
            <button
              type="button"
              onClick={onToggleCollapsed}
              className="m-collapse-btn grid h-7 w-7 shrink-0 place-items-center rounded-full shadow-sm"
              title={`Collapse ${ariaLabel}`}
              aria-label={`Collapse ${ariaLabel}`}
            >
              <CollapseIcon className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
      <div className="m-panel-body min-h-0 flex-1 overflow-hidden">{children}</div>
    </aside>
  )
}
