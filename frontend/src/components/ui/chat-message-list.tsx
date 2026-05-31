import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactNode } from 'react'

import { ToolCallHint } from '@/components/ui/tool-call-hint'
import { ChatMediaGallery } from '@/components/ui/chat-media'
import { ChatMarkdown } from '@/components/ui/chat-markdown'
import { ChatTypingDots } from '@/components/ui/chat-typing-dots'
import { stripAiActionBlocks } from '@/lib/aiActionBlocks'
import { splitAssistantDisplayContent } from '@/lib/aiReplySummary'
import { ChatReplySummaryPanel } from '@/components/ui/chat-reply-summary'
import { cn } from '@/lib/utils'
import type { ChatMessage } from '@/lib/useCursorAgentChat'

type ChatMessageListProps = {
  messages: ChatMessage[]
  className?: string
  emptyState?: ReactNode
  hasMoreOlder?: boolean
  loadingOlder?: boolean
  onLoadOlder?: () => void
  pinToBottom?: boolean
}

export type ChatMessageListHandle = {
  scrollToBottom: () => void
  preserveScrollOnPrepend: () => void
}

export const ChatMessageList = forwardRef<ChatMessageListHandle, ChatMessageListProps>(function ChatMessageList(
  {
    messages,
    className,
    emptyState,
    hasMoreOlder = false,
    loadingOlder = false,
    onLoadOlder,
    pinToBottom = false,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(pinToBottom)
  const pendingScrollRestoreRef = useRef<number | null>(null)

  useEffect(() => {
    pinnedRef.current = pinToBottom
  }, [pinToBottom])

  useImperativeHandle(ref, () => ({
    scrollToBottom() {
      const el = containerRef.current
      if (!el) return
      el.scrollTop = el.scrollHeight
    },
    preserveScrollOnPrepend() {
      const el = containerRef.current
      if (!el) return
      pendingScrollRestoreRef.current = el.scrollHeight
    },
  }))

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    if (pendingScrollRestoreRef.current != null) {
      el.scrollTop = el.scrollHeight - pendingScrollRestoreRef.current
      pendingScrollRestoreRef.current = null
      return
    }

    if (pinnedRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages, loadingOlder])

  return (
    <div
      ref={containerRef}
      className={cn(
        'min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3 font-sans text-sm leading-relaxed',
        className,
      )}
      onScroll={event => {
        const el = event.currentTarget
        const nearTop = el.scrollTop < 96
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        pinnedRef.current = nearBottom

        if (nearTop && hasMoreOlder && !loadingOlder) {
          onLoadOlder?.()
        }
      }}
    >
      {messages.length > 0 ? (
        <div className="flex justify-center px-4 pb-1">
          {hasMoreOlder ? (
            <button
              type="button"
              disabled={loadingOlder}
              onClick={() => onLoadOlder?.()}
              className="rounded-full border border-border/70 bg-card/70 px-3 py-1 text-[11px] text-text-secondary transition-colors hover:border-accent/40 hover:text-text-primary disabled:opacity-50"
            >
              {loadingOlder ? 'Loading older messages…' : 'Load older messages'}
            </button>
          ) : (
            <span className="text-[10px] text-text-secondary/70">Beginning of session</span>
          )}
        </div>
      ) : null}

      {messages.length === 0 && emptyState ? emptyState : null}

      {messages.map(message => {
        const assistantParts =
          message.role === 'assistant'
            ? splitAssistantDisplayContent(message.content, Boolean(message.streaming))
            : null
        const displayContent = assistantParts
          ? stripAiActionBlocks(assistantParts.body, Boolean(message.streaming))
          : message.content
        const replySummary =
          message.role === 'assistant' && !message.streaming
            ? message.replySummary ?? assistantParts?.summary ?? null
            : null

        if (message.role === 'assistant' && !displayContent && !message.streaming) {
          return null
        }

        if (message.role === 'tool') {
          return (
            <div key={message.id} className="px-10 py-0.5">
              <ToolCallHint
                label={message.content}
                status={message.toolStatus ?? 'running'}
                detail={message.toolDetail}
              />
            </div>
          )
        }

        const isUser = message.role === 'user'
        const isAssistant = message.role === 'assistant'

        return (
          <div
            key={message.id}
            className={cn(
              'flex w-full',
              isUser && 'justify-end pl-20 pr-6',
              isAssistant && 'justify-start pl-6 pr-20',
              message.role === 'system' && 'justify-center px-10',
            )}
          >
            <div
              className={cn(
                'max-w-[min(100%,40rem)] rounded-xl px-3.5 py-2.5',
                isUser &&
                  'rounded-br-md border border-accent/35 bg-accent/15 text-text-primary whitespace-pre-wrap shadow-sm',
                isAssistant &&
                  'rounded-bl-md border border-border/70 bg-card/85 text-text-primary shadow-sm',
                message.role === 'system' &&
                  'whitespace-pre-wrap border border-red-500/30 bg-red-500/10 text-red-300',
              )}
            >
              {isUser ? (
                <>
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-accent/80">You</div>
                  {message.content}
                </>
              ) : isAssistant ? (
                <>
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                    Strategy AI
                  </div>
                  {displayContent ? <ChatMarkdown content={displayContent} /> : null}
                  <ChatMediaGallery attachments={message.attachments} />
                  {replySummary ? <ChatReplySummaryPanel summary={replySummary} /> : null}
                  {message.streaming ? (
                    displayContent ? (
                      <ChatTypingDots className="mt-2" />
                    ) : (
                      <span className="text-text-secondary">Thinking…</span>
                    )
                  ) : null}
                </>
              ) : (
                message.content
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
})
