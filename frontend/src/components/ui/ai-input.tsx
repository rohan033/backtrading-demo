import React from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { GripHorizontal, Globe, Maximize2, Minimize2, Send, Sparkles, Square, X } from 'lucide-react'

import { AI_WORKFLOWS } from '@/lib/ai-workflows'
import { ChatMessageList, type ChatMessageListHandle } from '@/components/ui/chat-message-list'
import { ToolCallsCollapsible } from '@/components/ui/tool-calls-collapsible'
import { cn } from '@/lib/utils'
import type { AgentInteractionMode, ChatMessage } from '@/lib/useCursorAgentChat'

const MIN_W = 320
const MIN_H = 280
const DEFAULT_W = 460
const DEFAULT_H = 640
const MAXIMIZED_W = 620
const MAXIMIZED_H = 820

type PanelSize = { width: number; height: number }
type PanelAnchor = { right: number; bottom: number }
type SizePreset = 'default' | 'maximized' | 'custom'

function AiMark({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const box = size === 'sm' ? 'h-6 w-6' : 'h-7 w-7'
  const icon = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4'

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-accent/25 to-accent-2/25 ring-1 ring-white/10',
        box,
      )}
    >
      <Sparkles className={cn(icon, 'text-accent')} strokeWidth={2} />
    </span>
  )
}

function clampSize(size: PanelSize): PanelSize {
  return {
    width: Math.max(MIN_W, size.width),
    height: Math.max(MIN_H, size.height),
  }
}

function clampAnchor(anchor: PanelAnchor, size: { width: number; height: number }, margin = 48): PanelAnchor {
  const maxRight = Math.max(0, window.innerWidth - size.width - margin)
  const maxBottom = Math.max(0, window.innerHeight - size.height - margin)
  return {
    right: Math.min(maxRight, Math.max(0, anchor.right)),
    bottom: Math.min(maxBottom, Math.max(0, anchor.bottom)),
  }
}

export type MorphPanelProps = {
  onSubmit: (message: string) => Promise<boolean> | boolean
  onStop?: () => void
  interactionMode?: AgentInteractionMode
  onInteractionModeChange?: (mode: AgentInteractionMode) => void
  webSearchEnabled?: boolean
  onWebSearchEnabledChange?: (enabled: boolean) => void
  sending?: boolean
  connected?: boolean
  statusText?: string
  error?: string
  messages?: ChatMessage[]
  className?: string
  onOpenChange?: (open: boolean) => void
}

export function MorphPanel({
  onSubmit,
  onStop,
  interactionMode = 'ask',
  onInteractionModeChange,
  webSearchEnabled = true,
  onWebSearchEnabledChange,
  sending = false,
  connected = false,
  statusText = 'Connecting…',
  error = '',
  messages = [],
  className,
  onOpenChange,
}: MorphPanelProps) {
  const panelRef = React.useRef<HTMLDivElement>(null)
  const launcherRef = React.useRef<HTMLButtonElement>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const messagesRef = React.useRef<ChatMessageListHandle>(null)

  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState('')
  const [sizePreset, setSizePreset] = React.useState<SizePreset>('default')
  const [panelSize, setPanelSize] = React.useState<PanelSize>({
    width: DEFAULT_W,
    height: DEFAULT_H,
  })
  const [anchor, setAnchor] = React.useState<PanelAnchor>({ right: 0, bottom: 0 })

  const dragSession = React.useRef<{ startX: number; startY: number; startAnchor: PanelAnchor } | null>(null)
  const launcherDragRef = React.useRef<{
    startX: number
    startY: number
    startAnchor: PanelAnchor
    moved: boolean
  } | null>(null)
  const resizeSession = React.useRef<{
    axis: 'corner' | 'left' | 'top'
    startX: number
    startY: number
    startSize: PanelSize
  } | null>(null)

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
    messagesRef.current?.scrollToBottom()
  }, [messages, sending, open])

  React.useEffect(() => {
    if (!open) return
    setAnchor(prev => clampAnchor(prev, panelSize))
  }, [open, panelSize])

  React.useEffect(() => {
    function launcherSize() {
      const el = launcherRef.current
      return {
        width: el?.offsetWidth ?? 140,
        height: el?.offsetHeight ?? 44,
      }
    }

    function onMove(event: MouseEvent) {
      if (launcherDragRef.current) {
        const dx = event.clientX - launcherDragRef.current.startX
        const dy = event.clientY - launcherDragRef.current.startY
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
          launcherDragRef.current.moved = true
        }
        setAnchor(
          clampAnchor(
            {
              right: launcherDragRef.current.startAnchor.right - dx,
              bottom: launcherDragRef.current.startAnchor.bottom - dy,
            },
            launcherSize(),
          ),
        )
      }
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
        const { axis, startX, startY, startSize } = resizeSession.current
        const dx = startX - event.clientX
        const dy = startY - event.clientY
        setSizePreset('custom')
        setPanelSize(
          clampSize({
            width: axis === 'top' ? startSize.width : startSize.width + dx,
            height: axis === 'left' ? startSize.height : startSize.height + dy,
          }),
        )
      }
    }

    function onUp() {
      if (launcherDragRef.current) {
        if (!launcherDragRef.current.moved) {
          setOpenState(true)
        }
        launcherDragRef.current = null
      }
      dragSession.current = null
      resizeSession.current = null
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [panelSize, setOpenState])

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
    if (!connected) return
    const sent = await onSubmit(text)
    if (sent) setDraft('')
  }, [connected, draft, onSubmit, sending])

  const runQuickPrompt = React.useCallback(
    async (prompt: string) => {
      if (sending || !connected) return
      await onSubmit(prompt)
    },
    [connected, onSubmit, sending],
  )

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    void submitDraft()
  }

  const statusLabel = connected ? statusText : 'Connecting…'
  const canSend = connected && !sending && Boolean(draft.trim())

  const chatMessages = React.useMemo(
    () => messages.filter(message => message.role !== 'tool'),
    [messages],
  )
  const toolMessages = React.useMemo(
    () => messages.filter(message => message.role === 'tool'),
    [messages],
  )

  return (
    <div className={cn('font-sans', className)}>
      <AnimatePresence mode="wait">
        {!open ? (
          <motion.button
            key="launcher"
            ref={launcherRef}
            type="button"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            title="Drag to move · Click to open"
            style={{
              right: 24 + anchor.right,
              bottom: 24 + anchor.bottom,
            }}
            onMouseDown={event => {
              event.preventDefault()
              launcherDragRef.current = {
                startX: event.clientX,
                startY: event.clientY,
                startAnchor: anchor,
                moved: false,
              }
            }}
            className="fixed z-50 flex cursor-grab select-none items-center gap-2.5 rounded-full border border-border bg-card px-4 py-2.5 text-sm font-medium text-text-primary shadow-lg backdrop-blur-md transition-colors hover:bg-secondary active:cursor-grabbing"
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
              className="relative flex shrink-0 cursor-grab items-center justify-between gap-2 border-b border-border/80 bg-primary/40 py-2 pr-3 pl-8 active:cursor-grabbing"
              onMouseDown={event => {
                if ((event.target as HTMLElement).closest('button, [data-panel-resize]')) return
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
            <div className="flex min-h-0 flex-1 flex-col">
              <ChatMessageList
                ref={messagesRef}
                messages={chatMessages}
                pinToBottom
                emptyState={
                  <div className="flex flex-col items-start gap-3 py-2">
                    <AiMark />
                    <div>
                      <p className="font-display text-base font-bold tracking-tightest text-text-primary">
                        Strategy AI
                      </p>
                      <p className="mt-1 text-sm text-text-secondary">
                        Ask about strategies, live executions, brokers, or this codebase. Pick a
                        quick workflow below to get started.
                      </p>
                    </div>
                  </div>
                }
              />
              <ToolCallsCollapsible tools={toolMessages} />
            </div>

            {error ? (
              <div className="shrink-0 border-b border-red/30 bg-red/10 px-3 py-2 text-xs text-red">
                {error}
              </div>
            ) : null}

            {/* Input — always bottom */}
            <form
              onSubmit={event => void handleSubmit(event)}
              className="shrink-0 border-t border-border/80 bg-primary/30 p-3"
            >
              <div className="mb-2">
                <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-text-secondary">
                  Quick workflows
                </p>
                <div className="flex gap-1.5 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {AI_WORKFLOWS.map(workflow => (
                    <button
                      key={workflow.id}
                      type="button"
                      disabled={!connected || sending}
                      onClick={() => void runQuickPrompt(workflow.prompt)}
                      className="shrink-0 rounded-full border border-border/70 bg-primary/50 px-2.5 py-1 text-[11px] text-text-primary transition-colors hover:border-accent/40 hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {workflow.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <div
                    className="inline-flex rounded-lg border border-border/60 bg-primary/50 p-0.5"
                    role="group"
                    aria-label="Agent interaction mode"
                  >
                    {(['ask', 'execute'] as const).map(mode => (
                      <button
                        key={mode}
                        type="button"
                        disabled={sending}
                        aria-pressed={interactionMode === mode}
                        onClick={() => onInteractionModeChange?.(mode)}
                        className={cn(
                          'rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                          interactionMode === mode
                            ? mode === 'execute'
                              ? 'bg-accent/20 text-accent'
                              : 'bg-card text-text-primary shadow-sm'
                            : 'text-text-secondary hover:text-text-primary',
                        )}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    disabled={sending}
                    aria-pressed={webSearchEnabled}
                    aria-label="Toggle web search for stock analysis"
                    title={
                      webSearchEnabled
                        ? 'Web search on — agent can look up live market data'
                        : 'Web search off — answers use repo and saved data only'
                    }
                    onClick={() => onWebSearchEnabledChange?.(!webSearchEnabled)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                      webSearchEnabled
                        ? 'border-accent-2/40 bg-accent-2/15 text-accent-2'
                        : 'border-border/60 bg-primary/50 text-text-secondary hover:text-text-primary',
                    )}
                  >
                    <Globe className="h-3.5 w-3.5" />
                    Web search
                  </button>
                </div>
                <span className="text-[11px] text-text-secondary">
                  {interactionMode === 'ask'
                    ? 'Ask · research & Q&A'
                    : 'Execute · apply changes & control plane'}
                  {webSearchEnabled ? ' · web search hint on' : ''}
                </span>
              </div>
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
                {sending ? (
                  <button
                    type="button"
                    onClick={() => onStop?.()}
                    aria-label="Stop response"
                    title="Stop response"
                    className="rounded-lg bg-red/15 p-2.5 text-red transition-colors hover:bg-red/25"
                  >
                    <Square className="h-4 w-4 fill-current" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={!canSend}
                    className="rounded-lg bg-accent/20 p-2.5 text-accent transition-colors hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                )}
              </div>
              <p className="mt-2 text-[11px] text-text-secondary">
                {statusLabel} · Enter to send · Shift+Enter for new line
              </p>
            </form>

            {/* Resize handles — top-left anchor (panel grows down/right) */}
            <div
              data-panel-resize
              aria-label="Resize width"
              title="Drag to resize width"
              className="absolute top-14 bottom-14 left-0 z-10 w-2 cursor-ew-resize"
              onMouseDown={event => {
                event.preventDefault()
                event.stopPropagation()
                resizeSession.current = {
                  axis: 'left',
                  startX: event.clientX,
                  startY: event.clientY,
                  startSize: panelSize,
                }
              }}
            />
            <div
              data-panel-resize
              aria-label="Resize height"
              title="Drag to resize height"
              className="absolute top-0 right-14 left-14 z-10 h-2 cursor-ns-resize"
              onMouseDown={event => {
                event.preventDefault()
                event.stopPropagation()
                resizeSession.current = {
                  axis: 'top',
                  startX: event.clientX,
                  startY: event.clientY,
                  startSize: panelSize,
                }
              }}
            />
            <div
              data-panel-resize
              aria-label="Resize panel"
              title="Drag to resize"
              className="absolute top-0 left-0 z-20 flex h-5 w-5 cursor-nwse-resize items-start justify-start rounded-br-md bg-primary/50 p-0.5 transition-colors hover:bg-primary/80"
              onMouseDown={event => {
                event.preventDefault()
                event.stopPropagation()
                resizeSession.current = {
                  axis: 'corner',
                  startX: event.clientX,
                  startY: event.clientY,
                  startSize: panelSize,
                }
              }}
            >
              <svg viewBox="0 0 12 12" className="h-3 w-3 text-text-secondary">
                <path
                  d="M0 0H4M0 0V4M0 0L5 5M0 4H2M4 0V2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.25"
                  strokeLinecap="round"
                />
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
