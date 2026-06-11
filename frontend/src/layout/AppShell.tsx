import { Outlet } from 'react-router-dom'

import StickyWatchlistFeed from '@/components/sticky-feed/StickyWatchlistFeed'
import { WatchlistStreamProvider } from '@/context/WatchlistStreamContext'
import { FloatingAiAssistant } from '@/components/ui/glowing-ai-chat-assistant'
import Sidebar from './Sidebar'
import { SidebarProvider } from './sidebar-context'
import TopBar from './TopBar'

export default function AppShell() {
  return (
    <SidebarProvider>
      <WatchlistStreamProvider>
        <div className="relative flex h-screen overflow-hidden bg-primary">
          <div className="app-atmosphere z-0" aria-hidden="true" />
          <div className="app-grain z-0" aria-hidden="true" />
          <Sidebar />
          <div className="relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden">
            <TopBar />
            <StickyWatchlistFeed />
            <main className="min-h-0 flex-1 overflow-hidden">
              <Outlet />
            </main>
          </div>
          <FloatingAiAssistant />
        </div>
      </WatchlistStreamProvider>
    </SidebarProvider>
  )
}
