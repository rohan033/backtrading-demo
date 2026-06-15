const STORAGE_KEY = 'watchlist-seeded-tick-keys-v1'

export function loadSeededTickKeys(): Set<string> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter(item => typeof item === 'string'))
  } catch {
    return new Set()
  }
}

export function isTickKeySeeded(tickKey: string): boolean {
  return loadSeededTickKeys().has(tickKey)
}

export function markTickKeySeeded(tickKey: string): void {
  const keys = loadSeededTickKeys()
  if (keys.has(tickKey)) return
  keys.add(tickKey)
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...keys]))
}
