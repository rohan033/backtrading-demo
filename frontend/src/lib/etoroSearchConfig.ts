export type EtoroSearchMode = 'legacy' | 'algolia'

type EtoroSearchSettingsPayload = {
  mode: EtoroSearchMode
  updated_at: string | null
}

let cachedMode: EtoroSearchMode = 'legacy'
let loadPromise: Promise<EtoroSearchMode> | null = null

export function getCachedEtoroSearchMode(): EtoroSearchMode {
  return cachedMode
}

export async function fetchEtoroSearchMode(): Promise<EtoroSearchMode> {
  if (loadPromise) return loadPromise

  loadPromise = (async () => {
    try {
      const res = await fetch('/api/etoro/search-settings')
      const body = await res.json() as { status?: boolean; data?: EtoroSearchSettingsPayload }
      if (body.status && body.data?.mode === 'algolia') {
        cachedMode = 'algolia'
      } else {
        cachedMode = 'legacy'
      }
    } catch {
      cachedMode = 'legacy'
    }
    return cachedMode
  })()

  try {
    return await loadPromise
  } finally {
    loadPromise = null
  }
}

export async function saveEtoroSearchMode(mode: EtoroSearchMode): Promise<EtoroSearchMode> {
  const res = await fetch('/api/etoro/search-settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  })
  if (!res.ok) {
    throw new Error(`Failed to save eToro search mode (${res.status})`)
  }
  const body = await res.json() as { status?: boolean; data?: EtoroSearchSettingsPayload }
  cachedMode = body.data?.mode === 'algolia' ? 'algolia' : 'legacy'
  return cachedMode
}

export function invalidateEtoroSearchClientCache(): void {
  cachedMode = 'legacy'
}
