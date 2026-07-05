import { useCallback, useEffect, useState } from 'react'

/**
 * Tiny query-string router for the minimal shell.
 *
 * State lives entirely in `window.location.search` so the browser's
 * back/forward buttons "just work". Multiple components can call this hook
 * independently and stay in sync: programmatic `navigate()` calls broadcast a
 * custom event that every live hook instance listens to (alongside `popstate`
 * for real back/forward navigations).
 */
export type UrlState = Record<string, string>

const SYNC_EVENT = 'minimal-urlstate-change'

function readParams(): UrlState {
  const params = new URLSearchParams(window.location.search)
  const out: UrlState = {}
  params.forEach((value, key) => { out[key] = value })
  return out
}

export function buildShellUrl(patch: UrlState): string {
  const params = new URLSearchParams(window.location.search)
  for (const [key, value] of Object.entries(patch)) {
    if (value == null || value === '') params.delete(key)
    else params.set(key, value)
  }
  const qs = params.toString()
  return qs ? `${window.location.pathname}?${qs}` : window.location.pathname
}

export function useUrlState() {
  const [state, setState] = useState<UrlState>(readParams)

  useEffect(() => {
    const sync = () => setState(readParams())
    window.addEventListener('popstate', sync)
    window.addEventListener(SYNC_EVENT, sync)
    return () => {
      window.removeEventListener('popstate', sync)
      window.removeEventListener(SYNC_EVENT, sync)
    }
  }, [])

  /**
   * Merge `patch` into the current params and update the URL. Keys whose value
   * is empty/null are removed so the URL stays clean. By default this pushes a
   * new history entry (so Back undoes it); pass `{ replace: true }` to rewrite
   * the current entry instead.
   */
  const navigate = useCallback((patch: UrlState, opts?: { replace?: boolean }) => {
    const next = { ...readParams(), ...patch }
    for (const key of Object.keys(next)) {
      if (next[key] === '' || next[key] == null) delete next[key]
    }
    const qs = new URLSearchParams(next).toString()
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
    if (opts?.replace) window.history.replaceState(null, '', url)
    else window.history.pushState(null, '', url)
    window.dispatchEvent(new Event(SYNC_EVENT))
  }, [])

  return { state, navigate }
}
