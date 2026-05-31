export type ChatMediaAttachment = {
  path: string
  kind: 'image' | 'animation' | 'video'
  label?: string
}

const MEDIA_EXT =
  /\.(png|jpe?g|gif|webp|svg|webm|mp4|apng)(?:\?.*)?$/i

const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/g
const MEDIA_PATH_RE =
  /(?:^|[\s`"'(])([^\s`"')]+\.(?:png|jpe?g|gif|webp|svg|webm|mp4|apng))/gi

function mediaKind(path: string): ChatMediaAttachment['kind'] {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  if (ext === 'gif' || ext === 'webp' || ext === 'apng') return 'animation'
  if (ext === 'webm' || ext === 'mp4') return 'video'
  return 'image'
}

export function workspaceMediaUrl(path: string): string {
  const normalized = path.replace(/^\/+/, '')
  return `/api/workspace/media/${encodeURI(normalized)}`
}

export function isWorkspaceMediaPath(value: string): boolean {
  const text = value.trim()
  if (!text || /^https?:\/\//i.test(text) || text.startsWith('data:')) return false
  return MEDIA_EXT.test(text)
}

export function normalizeWorkspaceMediaPath(raw: string): string | null {
  const text = raw.trim().replace(/^['"]|['"]$/g, '')
  if (!isWorkspaceMediaPath(text)) return null

  const repoMarker = '/backtrading-demo/'
  const idx = text.indexOf(repoMarker)
  if (idx >= 0) {
    return text.slice(idx + repoMarker.length)
  }

  if (text.startsWith('/')) {
    const parts = text.split('/').filter(Boolean)
    return parts.slice(-2).join('/') || parts[parts.length - 1] || null
  }

  return text.replace(/^\.\//, '')
}

export function extractMediaPathsFromText(text: string): string[] {
  if (!text) return []

  const found: string[] = []
  const seen = new Set<string>()

  const add = (raw: string) => {
    const path = normalizeWorkspaceMediaPath(raw)
    if (!path || seen.has(path)) return
    seen.add(path)
    found.push(path)
  }

  for (const match of text.matchAll(MARKDOWN_IMAGE_RE)) {
    add(match[1])
  }
  for (const match of text.matchAll(MEDIA_PATH_RE)) {
    add(match[1])
  }

  return found
}

export function attachmentsFromPaths(paths: string[]): ChatMediaAttachment[] {
  const rows: ChatMediaAttachment[] = []
  const seen = new Set<string>()

  for (const raw of paths) {
    const path = normalizeWorkspaceMediaPath(raw)
    if (!path || seen.has(path)) continue
    seen.add(path)
    rows.push({
      path,
      kind: mediaKind(path),
      label: path.split('/').pop(),
    })
  }

  return rows
}

export function extractMediaAttachments(text: string): ChatMediaAttachment[] {
  return attachmentsFromPaths(extractMediaPathsFromText(text))
}

export function mergeAttachments(
  ...groups: Array<ChatMediaAttachment[] | undefined>
): ChatMediaAttachment[] {
  const rows: ChatMediaAttachment[] = []
  const seen = new Set<string>()

  for (const group of groups) {
    for (const item of group || []) {
      if (!item?.path || seen.has(item.path)) continue
      seen.add(item.path)
      rows.push({
        path: item.path,
        kind: item.kind || mediaKind(item.path),
        label: item.label || item.path.split('/').pop(),
      })
    }
  }

  return rows
}

export function resolveMarkdownImageSrc(src: string | undefined): string | undefined {
  if (!src) return undefined
  const trimmed = src.trim()
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('data:')) return trimmed
  const path = normalizeWorkspaceMediaPath(trimmed)
  return path ? workspaceMediaUrl(path) : trimmed
}
