import { NavLink } from 'react-router-dom'

import { NAV_GROUPS, SETTINGS_NAV } from './nav-config'

function navClass({ isActive }: { isActive: boolean }) {
  return [
    'flex items-center gap-2.5 rounded px-3 py-2 text-[11px] font-medium transition-colors',
    isActive
      ? 'bg-accent/15 text-accent'
      : 'text-text-secondary hover:bg-card hover:text-text-primary',
  ].join(' ')
}

export default function Sidebar() {
  const SettingsIcon = SETTINGS_NAV.icon

  return (
    <aside className="flex w-[260px] shrink-0 flex-col border-r border-border bg-secondary">
      <div className="border-b border-border px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-accent to-indigo-500 text-sm font-bold text-white">
            RS
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Rohan Saraf</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-secondary">
              <span className="h-1.5 w-1.5 rounded-full bg-green shadow-[0_0_0_2px_rgba(0,200,83,0.15)]" />
              Demo · eToro
            </div>
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-auto px-3 py-4">
        {NAV_GROUPS.map(group => (
          <div key={group.title} className="mb-5">
            <div className="mb-2 px-3 text-[8px] font-bold uppercase tracking-[1.5px] text-text-secondary">
              {group.title}
            </div>
            <div className="space-y-0.5">
              {group.items.map(item => {
                const Icon = item.icon
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    className={navClass}
                  >
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${item.iconBg}`}
                    >
                      <Icon className={`h-3.5 w-3.5 ${item.iconFg}`} aria-hidden="true" />
                    </span>
                    <span>{item.label}</span>
                  </NavLink>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-border px-3 py-3">
        <NavLink to={SETTINGS_NAV.to} className={navClass}>
          <span
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${SETTINGS_NAV.iconBg}`}
          >
            <SettingsIcon className={`h-3.5 w-3.5 ${SETTINGS_NAV.iconFg}`} aria-hidden="true" />
          </span>
          <span>{SETTINGS_NAV.label}</span>
        </NavLink>
      </div>
    </aside>
  )
}
