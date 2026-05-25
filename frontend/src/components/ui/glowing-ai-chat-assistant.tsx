import { useMemo, useState } from 'react'

import { MorphPanel } from '@/components/ui/ai-input'
import { useCursorAgentChat, type AgentInteractionMode } from '@/lib/useCursorAgentChat'

export function FloatingAiAssistant() {
  const [open, setOpen] = useState(false)
  const [interactionMode, setInteractionMode] = useState<AgentInteractionMode>('ask')
  const { messages, health, connected, sending, error, sendMessage, stopMessage } = useCursorAgentChat(
    open,
    interactionMode,
  )

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
      onSubmit={sendMessage}
      onStop={stopMessage}
      onOpenChange={setOpen}
    />
  )
}

export default FloatingAiAssistant
