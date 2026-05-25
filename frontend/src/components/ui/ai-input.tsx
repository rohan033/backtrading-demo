import React from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { GripHorizontal, Maximize2, Minimize2, Send, Sparkles, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { ChatMessage } from '@/lib/useCursorAgentChat'

const MIN_W = 320
const MIN_H = 280
const DEFAULT_W = 380
const DEFAULT_H = 340
const MAX_W = 720
const MAX_H = 640
const MAXIMIZED_W = 560
const MAXIMIZED_H = 520

type PanelSize = { width: number; height: number }
type PanelAnchor = { right: number; bottom: number }
type SizePreset = 'default' | 'maximized' | 'custom'

function AiMark({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const box = size === 'sm' ? 'h-6 w-6' : 'h-7 w-7'
  const icon = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500/20 to-sky-400/20 ring-1 ring-white/10',
        box,
      )}
    >
      <Sparkles className={cn(icon, 'text-sky-300')} strokeWidth={2} />
    </span>
  )
}

function clampSize(size: PanelSize): PanelSize {
  const maxWidth = Math.min(MAX_W, window.innerWidth - 48)
  const maxHeight = Math.min(MAX_H, window.innerHeight - 48)
  return {
    width: Math.min(maxWidth, Math.max(MIN_W, size.width)),
    height: Math.min(maxHeight, Math.max(MIN_H, size.height)),
  }
}

function clampAnchor(anchor: PanelAnchor, size: PanelSize): PanelAnchor {
  const maxRight = Math.max(0, window.innerWidth - size.width - 48)
  const maxBottom = Math.max(0, window.innerHeight - size.height - 48)
  return {
    right: Math.min(maxRight, Math.max(0, anchor.right)),
    bottom: Math.min(maxBottom, Math.max(0, anchor.bottom)),
  }
}

export type MorphPanelProps = {
  onSubmit: (message: string) => Promise<boolean> | boolean
  sending?: boolean
  connected?: boolean
  statusText?: string
  messages?: ChatMessage[]
  className?: string
  onOpenChange?: (open: boolean) => void
}

export function MorphPanel({
  onSubmit,
  sending = false,
  connected = false,
  statusText = 'Connecting…',
  messages = [],
  className,
  onOpenChange,
}: MorphPanelProps) {
  const panelRef = React.useRef<HTMLDivElement>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const messagesRef = React.useRef<HTMLDivElement>(null)

  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState('')
  const [sizePreset, setSizePreset] = React.useState<SizePreset>('default')
  const [panelSize, setPanelSize] = React.useState<PanelSize>({
    width: DEFAULT_W,
    height: DEFAULT_H,
  })
  const [anchor, setAnchor] = React.useState<PanelAnchor>({ right: 0, bottom: 0 })

  const dragSession = React.useRef<{ startX: number; startY: number; startAnchor: PanelAnchor } | null>(null)
  const resizeSession = React.useRef<{ startX: number; startY: number; startSize: PanelSize } | null>(null)

  const setOpenState = React.useCallback(
    (next: boolean) => {
      setOpen(next)
      onOpenChange?.(next)
      if (next) {
        window.setTimeout(() => textareaRef.current?.focus(), 120)
      } else {
        textareaRef.current?.blur()
      }
    },
    [onOpenChange],
  )

  React.useEffect(() => {
    if (!messagesRef.current) return
    messagesRef.current.scrollTop = messagesRef.current.scrollHeight
  }, [messages, sending, open])

  React.useEffect(() => {
    function onMove(event: MouseEvent) {
      if (dragSession.current) {
        const dx = event.clientX - dragSession.current.startX
        const dy = event.clientY - dragSession.current.startY
        setAnchor(
          clampAnchor(
            {
              right: dragSession.current.startAnchor.right - dx,
              bottom: dragSession.current.startAnchor.bottom - dy,
            },
            panelSize,
          ),
        )
      }
      if (resizeSession.current) {
        const dx = event.clientX - resizeSession.current.startX
        const dy = resizeSession.current.startY - event.clientY
        setSizePreset('custom')
        setPanelSize(
          clampSize({
            width: resizeSession.current.startSize.width + dx,
            height: resizeSession.current.startSize.height + dy,
          }),
        )
      }
    }

    function onUp() {
      dragSession.current = null
      resizeSession.current = null
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [panelSize])

  const applyPreset = (preset: 'default' | 'maximized') => {
    setSizePreset(preset)
    setPanelSize(
      clampSize({
        width: preset === 'maximized' ? MAXIMIZED_W : DEFAULT_W,
        height: preset === 'maximized' ? MAXIMIZED_H : DEFAULT_H,
      }),
    )
  }

  const submitDraft = React.useCallback(async () => {
    const text = draft.trim()
    if (!text || sending) return
    const sent = await onSubmit(text)
    if (sent) setDraft('')
  }, [draft, onSubmit, sending])

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    void submitDraft()
  }

  const statusLabel = connected ? statusText : 'Connecting…'

  return (
    <div className={cn('font-sans', className)}>
      <AnimatePresence mode="wait">
        {!open ? (
          <motion.button
            key="launcher"
            type="button"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            onClick={() => setOpenState(true)}
            className="fixed right-6 bottom-6 z-50 flex items-center gap-2.5 rounded-full border border-border bg-card px-4 py-2.5 text-sm font-medium text-text-primary shadow-lg backdrop-blur-md transition-colors hover:bg-secondary"
          >
            <AiMark />
            <span>Ask AI</span>
          </motion.button>
        ) : (
          <motion.div
            key="panel"
            ref={panelRef}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-border bg-card/98 shadow-2xl backdrop-blur-md"
            style={{
              right: 24 + anchor.right,
              bottom: 24 + anchor.bottom,
              width: panelSize.width,
              height: panelSize.height,
            }}
          >
            {/* Draggable header */}
            <div
              className="flex shrink-0 cursor-grab items-center justify-between gap-2 border-b border-border/80 bg-primary/40 px-3 py-2 active:cursor-grabbing"
              onMouseDown={event => {
                if ((event.target as HTMLElement).closest('button')) return
                dragSession.current = {
                  startX: event.clientX,
                  startY: event.clientY,
                  startAnchor: anchor,
                }
              }}
            >
              <div className="flex min-w-0 items-center gap-2">
                <GripHorizontal className="h-4 w-4 shrink-0 text-text-secondary" />
                <AiMark size="sm" />
                <span className="truncate text-sm font-medium text-text-primary">Strategy AI</span>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <WindowButton label="Maximize" onClick={() => applyPreset('maximized')}>
                  <Maximize2 className="h-3.5 w-3.5" />
                </WindowButton>
                <WindowButton label="Minimize to default size" onClick={() => applyPreset('default')}>
                  <Minimize2 className="h-3.5 w-3.5" />
                </WindowButton>
                <WindowButton label="Close" onClick={() => setOpenState(false)}>
                  <X className="h-3.5 w-3.5" />
                </WindowButton>
              </div>
            </div>

            {/* Messages */}
            <div
              ref={messagesRef}
              className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3 text-sm leading-relaxed"
            >
              {messages.length === 0 ? (
                <p className="text-text-secondary">
                  Ask about strategies, live executions, brokers, or this codebase.
                </p>
              ) : null}
              {messages.map(msg => (
                <div
                  key={msg.id}
                  className={cn(
                    'rounded-lg px-3 py-2 whitespace-pre-wrap',
                    msg.role === 'user' && 'ml-8 bg-accent/15 text-text-primary',
                    msg.role === 'assistant' && 'mr-6 border border-border/60 bg-primary/60 text-text-primary',
                    msg.role === 'system' && 'border border-red-500/30 bg-red-500/10 text-red-300',
                  )}
                >
                  {msg.content || (msg.streaming ? 'Thinking…' : '')}
                </div>
              ))}
            </div>

            {/* Input — always bottom */}
            <form
              onSubmit={event => void handleSubmit(event)}
              className="shrink-0 border-t border-border/80 bg-primary/30 p-3"
            >
              <div className="flex items-end gap-2">
                <textarea
                  ref={textareaRef}
                  value={draft}
                  onChange={event => setDraft(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Escape') setOpenState(false)
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      void submitDraft()
                    }
                  }}
                  rows={2}
                  disabled={sending}
                  placeholder="Type a message…"
                  className="min-h-[44px] flex-1 resize-none rounded-lg border border-border bg-primary px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-secondary focus:border-accent/60"
                />
                <button
                  type="submit"
                  disabled={sending || !draft.trim()}
                  className="rounded-lg bg-accent/20 p-2.5 text-accent transition-colors hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
              <p className="mt-2 text-[11px] text-text-secondary">
                {statusLabel} · Enter to send · Shift+Enter for new line
              </p>
            </form>

            {/* Resize handle */}
            <div
              aria-label="Resize panel"
              className="absolute right-0 bottom-0 h-4 w-4 cursor-nwse-resize"
              onMouseDown={event => {
                event.preventDefault()
                resizeSession.current = {
                  startX: event.clientX,
                  startY: event.clientY,
                  startSize: panelSize,
                }
              }}
            >
              <svg viewBox="0 0 16 16" className="h-full w-full text-text-secondary/60">
                <path d="M14 14L8 14L14 8Z" fill="currentColor" />
              </svg>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function WindowButton({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-card hover:text-text-primary"
    >
      {children}
    </button>
  )
}

export default MorphPanel
