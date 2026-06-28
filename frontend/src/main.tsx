import React from 'react'
import ReactDOM from 'react-dom/client'

import MinimalShell from './layout/minimal/MinimalShell'

// Minimal global reset only — no dark-theme tokens loaded
import './minimal-base.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MinimalShell />
  </React.StrictMode>,
)
