import { ChevronRight, Loader2 } from 'lucide-react'

import { ChatMediaGallery } from '@/components/ui/chat-media'
import { ToolCallHint } from '@/components/ui/tool-call-hint'
import { ToolCallMcpArgsAccordion } from '@/components/ui/tool-call-mcp-args'
import '@/components/ui/tool-call-mcp-args.css'
import { extractMcpToolArgs } from '@/lib/tool-call-display'
import { extractMediaAttachments } from '@/lib/workspaceMedia'
import type { ChatMessage } from '@/lib/useCursorAgentChat'
import { cn } from '@/lib/utils'

type ToolCallsCollapsibleProps = {
  tools: ChatMessage[]
  className?: string
}

export function ToolCallsCollapsible({ tools, className }: ToolCallsCollapsibleProps) {
  if (!tools.length) return null

  const latest = tools[tools.length - 1]
  const runningCount = tools.filter(tool => tool.toolStatus === 'running').length

  return (
    <details
      className={cn(
        'group shrink-0 border-t border-border/80 bg-primary/25',
        className,
      )}
    >
      <summary
        className={cn(
          'flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[11px]',
          '[&::-webkit-details-marker]:hidden',
        )}
      >
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-secondary transition-transform group-open:rotate-90" />
        <span className="shrink-0 font-medium uppercase tracking-wide text-text-secondary">
          Tool calls
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-text-primary/85">
          {latest.content}
        </span>
        {runningCount > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-sky-300/90">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>{runningCount}</span>
          </span>
        ) : null}
        <span className="shrink-0 rounded-full bg-card/80 px-1.5 py-0.5 text-[10px] text-text-secondary">
          {tools.length}
        </span>
      </summary>
      <div className="max-h-36 overflow-y-auto border-t border-border/50 px-2 py-1">
        {tools.map(tool => {
          const media = extractMediaAttachments(tool.toolDetail || '')
          const toolEvent = tool.toolEvent || {
            tool_name: tool.toolName,
            args: tool.toolDetail,
            detail: tool.toolDetail,
          }
          const showArgsAccordion = Boolean(extractMcpToolArgs(toolEvent))
          return (
            <div key={tool.id} className="py-0.5">
              <ToolCallHint
                label={tool.content}
                status={tool.toolStatus ?? 'running'}
                detail={showArgsAccordion ? undefined : tool.toolDetail}
              />
              <ToolCallMcpArgsAccordion
                toolName={tool.toolName || 'tool'}
                event={toolEvent}
              />
              {tool.toolStatus === 'completed' && media.length ? (
                <ChatMediaGallery attachments={media} className="px-2 pb-1" />
              ) : null}
            </div>
          )
        })}
      </div>
    </details>
  )
}
