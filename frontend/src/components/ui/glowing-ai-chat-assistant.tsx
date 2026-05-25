import { useMemo, useState } from 'react'

import { MorphPanel } from '@/components/ui/ai-input'
import { useCursorAgentChat } from '@/lib/useCursorAgentChat'

export function FloatingAiAssistant() {
  const [open, setOpen] = useState(false)
  const { messages, health, connected, sending, sendMessage } = useCursorAgentChat(open)

  const statusText = useMemo(() => {
    if (!connected) return 'Connecting…'
    if (!health?.ready) return health?.message || 'Set CURSOR_API_KEY in .cursor-api.env'
    return 'Connected via WebSocket'
  }, [connected, health])

  return (
    <MorphPanel
      messages={messages}
      sending={sending}
      connected={connected}
      statusText={statusText}
      onSubmit={sendMessage}
      onOpenChange={setOpen}
    />
  )
}

export default FloatingAiAssistant
