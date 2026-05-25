import { Outlet } from 'react-router-dom'

import Sidebar from './Sidebar'
import { SidebarProvider } from './sidebar-context'
import TopBar from './TopBar'

export default function AppShell() {
  return (
    <SidebarProvider>
      <div className="flex h-screen overflow-hidden bg-primary">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <TopBar />
          <main className="min-h-0 flex-1 overflow-hidden">
            <Outlet />
          </main>
        </div>
      </div>
    </SidebarProvider>
  )
}
