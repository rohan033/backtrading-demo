import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'

import MinimalDrawer from './MinimalDrawer'
import MinimalTabPills from './MinimalTabPills'

const STORAGE_KEY = 'minimal-ui-left-collapsed'

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export default function LeftOrdersDrawer() {
  const [collapsed, setCollapsed] = useState(loadCollapsed)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0')
    } catch {
      // ignore
    }
  }, [collapsed])

  return (
    <MinimalDrawer
      side="left"
      headerClass="m-left-header"
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed(value => !value)}
      ariaLabel="Orders panel"
      header={
        <MinimalTabPills
          mode="route"
          tabs={[
            { id: 'orders', label: 'Orders', to: '/trade/activity', end: false },
          ]}
        />
      }
    >
      <div className="flex h-full flex-col p-3">
        <p className="text-[11px] text-[rgb(var(--m-text-muted))]">
          Order activity and management live here. Use the Orders tab to open the full view.
        </p>
        <NavLink
          to="/trade/activity"
          className="mt-3 inline-flex w-fit rounded-lg m-border m-tab-idle px-3 py-1.5 text-[11px] font-semibold text-[rgb(var(--m-text))] hover:m-tab-active"
        >
          Open orders
        </NavLink>
      </div>
    </MinimalDrawer>
  )
}
