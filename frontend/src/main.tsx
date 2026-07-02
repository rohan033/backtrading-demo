import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import { WatchlistStreamProvider } from './context/WatchlistStreamContext'
import MinimalShell from './layout/minimal/MinimalShell'
import { PlatformToastHost } from './lib/platform-toast'

// Load utility classes for shared components, then let the minimal reset own the shell.
import './index.css'
import './minimal-base.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <WatchlistStreamProvider>
        <MinimalShell />
        <PlatformToastHost />
      </WatchlistStreamProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
