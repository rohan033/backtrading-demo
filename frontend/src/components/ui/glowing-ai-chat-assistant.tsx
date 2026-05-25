import { useMemo, useState } from 'react'

import { MorphPanel } from '@/components/ui/ai-input'
import { useCursorAgentChat } from '@/lib/useCursorAgentChat'

export function FloatingAiAssistant() {
  const [open, setOpen] = useState(false)
  const { messages, health, connected, sending, error, sendMessage } = useCursorAgentChat(open)

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
      onSubmit={sendMessage}
      onOpenChange={setOpen}
    />
  )
}

export default FloatingAiAssistant
