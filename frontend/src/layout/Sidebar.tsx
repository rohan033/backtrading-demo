import { NavLink } from 'react-router-dom'
import type { ReactNode } from 'react'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'

import { NAV_GROUPS, SETTINGS_NAV } from './nav-config'
import { useSidebar } from './sidebar-context'

function navClass({ isActive }: { isActive: boolean }, collapsed: boolean) {
  return [
    'group/nav relative flex items-center rounded-md text-[12.5px] font-medium transition-all duration-150',
    collapsed ? 'group justify-center px-2 py-2.5' : 'gap-2.5 px-2.5 py-2',
    isActive
      ? 'bg-accent/[0.12] text-accent shadow-[inset_0_0_0_1px_rgb(var(--c-accent)/0.18)]'
      : 'text-text-secondary hover:bg-card-hi/70 hover:text-text-primary',
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
          className="absolute -left-1 top-1/2 h-0 w-0 -translate-y-1/2 border-y-[6px] border-y-transparent border-r-[7px] border-r-accent drop-shadow-[0_0_6px_rgb(var(--c-accent)/0.55)]"
        />
        <span className="whitespace-nowrap rounded-md bg-accent px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-primary shadow-[0_6px_18px_rgb(var(--c-accent)/0.35)]">
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
      className={`relative z-30 flex shrink-0 flex-col border-r border-border bg-secondary transition-[width] duration-200 ease-in-out ${
        collapsed ? 'w-[72px] overflow-visible' : 'w-[264px]'
      }`}
    >
      <div className={`flex h-16 items-center border-b border-border ${collapsed ? 'justify-center px-2' : 'px-4'}`}>
        <div className={`flex items-center ${collapsed ? 'flex-col gap-2' : 'gap-3'}`}>
          <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-amber-600 font-display text-base font-extrabold text-primary shadow-[0_4px_14px_rgb(var(--c-accent)/0.35)]">
            RS
            <span className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5 rounded-full border-2 border-secondary bg-green" />
          </div>
          {!collapsed ? (
            <div className="min-w-0">
              <div className="truncate font-display text-[15px] font-bold tracking-tightest text-text-primary">Rohan Saraf</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-text-secondary">
                <span className="inline-flex h-1.5 w-1.5 rounded-full bg-green shadow-[0_0_0_3px_rgb(var(--c-up)/0.15)]" />
                Demo · eToro
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <nav className={`stagger-rise flex-1 py-4 ${collapsed ? 'overflow-visible px-2' : 'overflow-auto px-3'}`}>
        {NAV_GROUPS.map(group => (
          <div key={group.title} className={collapsed ? 'mb-3' : 'mb-5'}>
            {!collapsed ? (
              <div className="mb-2 flex items-center gap-2 px-2.5 text-[10px] font-bold uppercase tracking-[0.18em] text-text-secondary/70">
                <span>{group.title}</span>
                <span className="h-px flex-1 bg-border/70" />
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
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ring-white/[0.04] transition-colors ${item.iconBg}`}
                    >
                      {item.iconText ? (
                        <span className={`text-[10px] font-black tracking-tight ${item.iconFg}`}>
                          {item.iconText}
                        </span>
                      ) : Icon ? (
                        <Icon className={`h-[15px] w-[15px] ${item.iconFg}`} aria-hidden="true" />
                      ) : null}
                    </span>
                    {!collapsed ? <span className="truncate">{item.label}</span> : null}
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
          className={`group relative flex w-full items-center rounded-md border border-border/60 bg-card/40 text-text-secondary transition-colors hover:border-border hover:bg-card-hi hover:text-text-primary ${
            collapsed ? 'justify-center px-2 py-2' : 'gap-2 px-3 py-2 text-[11.5px] font-medium'
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
