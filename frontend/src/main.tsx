import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'

import AppShell from './layout/AppShell'
import { PlatformToastHost } from './lib/platform-toast'
import { AiResearchListPage } from './pages/learn/AiResearchListPage'
import { AiResearchSessionPage } from './pages/learn/AiResearchSessionPage'
import BacktestLabPage from './pages/learn/BacktestLabPage'
import SimulationPage from './pages/learn/SimulationPage'
import ToolsPage from './pages/learn/ToolsPage'
import DashboardPage from './pages/monitor/DashboardPage'
import MarketPage from './pages/monitor/MarketPage'
import PortfolioPage from './pages/monitor/PortfolioPage'
import WatchlistPage from './pages/monitor/WatchlistPage'
import HistoryPage from './pages/insights/HistoryPage'
import LiveServersPage from './pages/insights/LiveServersPage'
import PerformancePage from './pages/insights/PerformancePage'
import FeaturesPage from './pages/FeaturesPage'
import SettingsPage from './pages/SettingsPage'
import {
  ActivityPage,
  ChartsPage,
  StrategiesListPage,
  StrategyCreatePage,
  StrategyDetailPage,
  TradeLayout,
} from './pages/trade/TradePages'
import { ExecutionProvider } from './ExecutionWorkspace'
import './index.css'

function ResearchLayout() {
  return (
    <ExecutionProvider>
      <Outlet />
    </ExecutionProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <PlatformToastHost />
      <Routes>
        <Route path="/features" element={<FeaturesPage />} />
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/portfolio" element={<PortfolioPage />} />
          <Route path="/watchlist" element={<WatchlistPage />} />
          <Route path="/market" element={<MarketPage />} />

          <Route path="/trade" element={<TradeLayout />}>
            <Route index element={<Navigate to="/trade/strategies" replace />} />
            <Route path="strategies" element={<StrategiesListPage />} />
            <Route path="strategies/new" element={<StrategyCreatePage />} />
            <Route path="strategies/:id" element={<StrategyDetailPage />} />
            <Route path="activity" element={<ActivityPage />} />
            <Route path="charts" element={<ChartsPage />} />
          </Route>

          <Route path="/learn/research" element={<ResearchLayout />}>
            <Route index element={<AiResearchListPage />} />
            <Route path=":sessionId" element={<AiResearchSessionPage />} />
          </Route>
          <Route path="/learn/backtest" element={<BacktestLabPage />} />
          <Route path="/learn/simulation" element={<SimulationPage />} />
          <Route path="/learn/tools" element={<ToolsPage />} />

          <Route path="/insights/live-servers" element={<LiveServersPage />} />
          <Route path="/insights/performance" element={<PerformancePage />} />
          <Route path="/insights/history" element={<HistoryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
)
