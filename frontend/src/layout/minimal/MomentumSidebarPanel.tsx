import { useState } from 'react'

import type { WatchlistTick } from '../../lib/watchlists'
import MomentumOrdersPanel from './MomentumOrdersPanel'
import MomentumQueuePanel from './MomentumQueuePanel'

type SubTab = 'queue' | 'orders'

export default function MomentumSidebarPanel({
  ticks,
  filterText,
}: {
  ticks: Record<string, WatchlistTick>
  filterText: string
}) {
  const [subTab, setSubTab] = useState<SubTab>('queue')

  return (
    <div className="ms-mom-sidebar">
      <div className="ms-mom-sidebar__tabs">
        <button
          type="button"
          className={`ms-mom-sidebar__tab${subTab === 'queue' ? ' ms-mom-sidebar__tab--active' : ''}`}
          onClick={() => setSubTab('queue')}
        >
          Queue
        </button>
        <button
          type="button"
          className={`ms-mom-sidebar__tab${subTab === 'orders' ? ' ms-mom-sidebar__tab--active' : ''}`}
          onClick={() => setSubTab('orders')}
        >
          Orders
        </button>
      </div>
      {subTab === 'queue' ? (
        <MomentumQueuePanel filterText={filterText} />
      ) : (
        <MomentumOrdersPanel ticks={ticks} filterText={filterText} />
      )}
    </div>
  )
}
