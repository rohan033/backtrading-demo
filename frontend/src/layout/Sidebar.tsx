import { NavLink } from 'react-router-dom'
import type { ReactNode } from 'react'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'

import { NAV_GROUPS, SETTINGS_NAV } from './nav-config'
import { useSidebar } from './sidebar-context'

function navClass({ isActive }: { isActive: boolean }, collapsed: boolean) {
  return [
    'flex items-center rounded text-[11px] font-medium transition-colors',
    collapsed ? 'group relative justify-center px-2 py-2.5' : 'gap-2.5 px-3 py-2',
    isActive
      ? 'bg-accent/15 text-accent'
      : 'text-text-secondary hover:bg-card hover:text-text-primary',
  ].join(' ')
}

function SidebarTooltip({ label, show }: { label: string; show: boolean }) {
  if (!show) return null

  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute left-[calc(100%+10px)] top-1/2 z-50 -translate-y-1/2 opacity-0 translate-x-[-6px] scale-90 transition-all duration-150 ease-out group-hover:opacity-100 group-hover:translate-x-0 group-hover:scale-100 group-focus-visible:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:scale-100"
    >
      <span className="relative inline-flex items-center">
        <span
          aria-hidden="true"
          className="absolute -left-1 top-1/2 h-0 w-0 -translate-y-1/2 border-y-[6px] border-y-transparent border-r-[7px] border-r-accent drop-shadow-[0_0_6px_rgba(29,161,242,0.55)]"
        />
        <span className="whitespace-nowrap rounded-full bg-gradient-to-r from-accent via-sky-400 to-indigo-400 px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-white shadow-[0_6px_18px_rgba(29,161,242,0.45)] ring-1 ring-white/20">
          {label}
        </span>
      </span>
    </span>
  )
}

function CollapsedNavItem({
  collapsed,
  label,
  children,
  className,
  ...props
}: {
  collapsed: boolean
  label: string
  children: ReactNode
  className: string | ((props: { isActive: boolean }) => string)
  to: string
  end?: boolean
}) {
  return (
    <NavLink {...props} aria-label={collapsed ? label : undefined} className={className}>
      {children}
      <SidebarTooltip label={label} show={collapsed} />
    </NavLink>
  )
}

export default function Sidebar() {
  const { collapsed, toggleCollapsed } = useSidebar()
  const SettingsIcon = SETTINGS_NAV.icon

  return (
    <aside
      className={`flex shrink-0 flex-col border-r border-border bg-secondary transition-[width] duration-200 ease-in-out ${
        collapsed ? 'w-[72px] overflow-visible' : 'w-[260px]'
      }`}
    >
      <div className={`border-b border-border ${collapsed ? 'px-2 py-3' : 'px-4 py-4'}`}>
        <div className={`flex items-center ${collapsed ? 'flex-col gap-2' : 'gap-3'}`}>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent to-indigo-500 text-sm font-bold text-white">
            RS
          </div>
          {!collapsed ? (
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">Rohan Saraf</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-secondary">
                <span className="h-1.5 w-1.5 rounded-full bg-green shadow-[0_0_0_2px_rgba(0,200,83,0.15)]" />
                Demo · eToro
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <nav className={`flex-1 py-4 ${collapsed ? 'overflow-visible px-2' : 'overflow-auto px-3'}`}>
        {NAV_GROUPS.map(group => (
          <div key={group.title} className={collapsed ? 'mb-3' : 'mb-5'}>
            {!collapsed ? (
              <div className="mb-2 px-3 text-[8px] font-bold uppercase tracking-[1.5px] text-text-secondary">
                {group.title}
              </div>
            ) : null}
            <div className="space-y-0.5">
              {group.items.map(item => {
                const Icon = item.icon
                return (
                  <CollapsedNavItem
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    collapsed={collapsed}
                    label={item.label}
                    className={props => navClass(props, collapsed)}
                  >
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${item.iconBg}`}
                    >
                      {item.iconText ? (
                        <span className={`text-[10px] font-black tracking-tight ${item.iconFg}`}>
                          {item.iconText}
                        </span>
                      ) : Icon ? (
                        <Icon className={`h-3.5 w-3.5 ${item.iconFg}`} aria-hidden="true" />
                      ) : null}
                    </span>
                    {!collapsed ? <span>{item.label}</span> : null}
                  </CollapsedNavItem>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className={`border-t border-border ${collapsed ? 'px-2 py-2' : 'px-3 py-3'} space-y-1`}>
        <CollapsedNavItem
          to={SETTINGS_NAV.to}
          collapsed={collapsed}
          label={SETTINGS_NAV.label}
          className={props => navClass(props, collapsed)}
        >
          <span
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${SETTINGS_NAV.iconBg}`}
          >
            <SettingsIcon className={`h-3.5 w-3.5 ${SETTINGS_NAV.iconFg}`} aria-hidden="true" />
          </span>
          {!collapsed ? <span>{SETTINGS_NAV.label}</span> : null}
        </CollapsedNavItem>

        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={`group relative flex w-full items-center rounded border border-border/60 bg-card/40 text-text-secondary transition-colors hover:bg-card hover:text-text-primary ${
            collapsed ? 'justify-center px-2 py-2' : 'gap-2 px-3 py-2 text-[11px] font-medium'
          }`}
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
          ) : (
            <>
              <PanelLeftClose className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Collapse panel</span>
            </>
          )}
          <SidebarTooltip label="Expand sidebar" show={collapsed} />
        </button>
      </div>
    </aside>
  )
}
