import React from 'react'
import ReactDOM from 'react-dom/client'

import { WatchlistStreamProvider } from './context/WatchlistStreamContext'
import MinimalShell from './layout/minimal/MinimalShell'

// Minimal global reset only — no dark-theme tokens loaded
import './minimal-base.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WatchlistStreamProvider>
      <MinimalShell />
    </WatchlistStreamProvider>
  </React.StrictMode>,
)
