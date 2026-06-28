import { Outlet } from 'react-router-dom'

import MinimalTabPills from './MinimalTabPills'

const MAIN_TABS = [
  { id: 'home', label: 'Home', to: '/dashboard', end: true },
  { id: 'watchlist', label: 'Watchlist', to: '/watchlist', end: false },
  { id: 'strategies', label: 'Strategies', to: '/trade/strategies', end: true },
]

export default function MainPanelChrome() {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col m-border border-y-0">
      <header className="m-main-header m-border flex h-12 shrink-0 items-center border-x-0 border-t-0 px-3">
        <MinimalTabPills mode="route" tabs={MAIN_TABS} />
      </header>
      <div className="m-panel-body min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </div>
    </section>
  )
}
