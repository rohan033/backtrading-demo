import { useEffect, useState } from 'react'

/**
 * A single, app-wide 1s ticker shared by every subscriber.
 *
 * - One `setInterval` regardless of how many components subscribe.
 * - Pauses while the tab is hidden (`visibilitychange`) and fires an immediate
 *   tick on resume so timers snap back to the correct value.
 */

type Listener = (now: number) => void

const listeners = new Set<Listener>()
let intervalId: ReturnType<typeof setInterval> | null = null
let lastNow = Date.now()

function emit() {
  lastNow = Date.now()
  for (const listener of listeners) listener(lastNow)
}

function start() {
  if (intervalId != null) return
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  emit()
  intervalId = setInterval(emit, 1000)
}

function stop() {
  if (intervalId == null) return
  clearInterval(intervalId)
  intervalId = null
}

function handleVisibility() {
  if (document.visibilityState === 'hidden') {
    stop()
  } else if (listeners.size > 0) {
    start()
  }
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibility)
    }
    start()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      stop()
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility)
      }
    }
  }
}

/**
 * Subscribe to the shared 1s ticker. Returns the current epoch-ms timestamp,
 * updated at most once per second and only while the tab is visible.
 */
export function useSecondTicker(): number {
  const [now, setNow] = useState(() => lastNow)

  useEffect(() => {
    setNow(Date.now())
    return subscribe(setNow)
  }, [])

  return now
}
