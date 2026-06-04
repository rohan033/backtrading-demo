import { useEffect, useMemo, useState } from 'react'

import { MorphPanel } from '@/components/ui/ai-input'
import { useCursorAgentChat, type AgentInteractionMode } from '@/lib/useCursorAgentChat'

const WEB_SEARCH_STORAGE_KEY = 'strategy-ai-web-search-enabled'

function readStoredWebSearchEnabled() {
  try {
    const raw = window.localStorage.getItem(WEB_SEARCH_STORAGE_KEY)
    if (raw == null) return true
    return raw !== '0' && raw !== 'false'
  } catch {
    return true
  }
}

export function FloatingAiAssistant() {
  const [open, setOpen] = useState(false)
  const [interactionMode, setInteractionMode] = useState<AgentInteractionMode>('ask')
  const [webSearchEnabled, setWebSearchEnabled] = useState(readStoredWebSearchEnabled)
  const { messages, health, connected, sending, error, sendMessage, stopMessage } = useCursorAgentChat(
    open,
    interactionMode,
    null,
    undefined,
    webSearchEnabled,
  )

  useEffect(() => {
    try {
      window.localStorage.setItem(WEB_SEARCH_STORAGE_KEY, webSearchEnabled ? '1' : '0')
    } catch {
      // ignore storage failures
    }
  }, [webSearchEnabled])

  const statusText = useMemo(() => {
    if (error && !connected) return error
    if (!connected) return 'Connecting to control plane…'
    if (!health?.ready) return health?.message || 'Set CURSOR_API_KEY in .cursor-api.env and restart the control plane'
    return 'Connected via WebSocket'
  }, [connected, error, health])

  return (
    <MorphPanel
      messages={messages}
      sending={sending}
      connected={connected}
      statusText={statusText}
      error={error}
      interactionMode={interactionMode}
      onInteractionModeChange={setInteractionMode}
      webSearchEnabled={webSearchEnabled}
      onWebSearchEnabledChange={setWebSearchEnabled}
      onSubmit={sendMessage}
      onStop={stopMessage}
      onOpenChange={setOpen}
    />
  )
}

export default FloatingAiAssistant
