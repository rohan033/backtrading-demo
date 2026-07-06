import { WatchlistStreamProvider } from '@/context/WatchlistStreamContext'
import { WatchlistDockProvider } from './watchlist-dock-context'
import LeftOrdersDrawer from './minimal/LeftOrdersDrawer'
import MainPanelChrome from './minimal/MainPanelChrome'
import RightNewsDrawer from './minimal/RightNewsDrawer'

import './minimal/minimal-theme.css'

/** Wireframe-inspired three-panel layout with pastel zone colors. */
export default function MinimalAppShell() {
  return (
    <WatchlistStreamProvider sessionQueueOnly>
      <WatchlistDockProvider>
        <div className="minimal-shell flex h-screen overflow-hidden">
          <LeftOrdersDrawer />
          <MainPanelChrome />
          <RightNewsDrawer />
        </div>
      </WatchlistDockProvider>
    </WatchlistStreamProvider>
  )
}
