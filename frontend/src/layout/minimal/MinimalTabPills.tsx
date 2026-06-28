import { NavLink } from 'react-router-dom'

import { cn } from '@/lib/utils'

type RouteTab = {
  id: string
  label: string
  to: string
  end?: boolean
}

type StateTab = {
  id: string
  label: string
  active: boolean
  onClick: () => void
}

type Props =
  | { mode: 'route'; tabs: RouteTab[] }
  | { mode: 'state'; tabs: StateTab[] }

const pillBase =
  'rounded-lg m-border px-3 py-1 text-[11px] font-semibold transition-colors'

export default function MinimalTabPills(props: Props) {
  if (props.mode === 'route') {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {props.tabs.map(tab => (
          <NavLink
            key={tab.id}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              cn(pillBase, isActive ? 'm-tab-active text-[rgb(var(--m-text))]' : 'm-tab-idle text-[rgb(var(--m-text-muted))] hover:text-[rgb(var(--m-text))]')
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {props.tabs.map(tab => (
        <button
          key={tab.id}
          type="button"
          onClick={tab.onClick}
          className={cn(
            pillBase,
            tab.active
              ? 'm-tab-active text-[rgb(var(--m-text))]'
              : 'm-tab-idle text-[rgb(var(--m-text-muted))] hover:text-[rgb(var(--m-text))]',
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
