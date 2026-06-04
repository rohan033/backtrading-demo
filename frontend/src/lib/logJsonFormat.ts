export function findLogJsonBody(message: string): string | null {
  const bodyPrefix = ' body='
  const bodyIdx = message.lastIndexOf(bodyPrefix)
  if (bodyIdx >= 0) {
    const candidate = message.slice(bodyIdx + bodyPrefix.length).trim()
    if (candidate.startsWith('{') || candidate.startsWith('[')) {
      return candidate
    }
  }

  const trimmed = message.trim()
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    return trimmed
  }

  return null
}

export function hasLogJsonBody(message: string): boolean {
  return findLogJsonBody(message) !== null
}

export function formatLogMessage(message: string, prettify: boolean): string {
  const jsonBody = findLogJsonBody(message)
  if (!jsonBody || !prettify) {
    return message
  }

  try {
    const pretty = JSON.stringify(JSON.parse(jsonBody), null, 2)
    return message.replace(jsonBody, pretty)
  } catch {
    return message
  }
}
