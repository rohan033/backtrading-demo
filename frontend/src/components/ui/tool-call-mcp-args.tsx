import {
  extractMcpToolArgs,
  formatMcpToolArgsBlock,
  isMcpToolCall,
  type ToolCallFields,
} from '@/lib/tool-call-display'
import { cn } from '@/lib/utils'

type Props = {
  toolName: string
  toolSource?: string
  event?: ToolCallFields
  className?: string
}

export function ToolCallMcpArgsAccordion({ toolName, toolSource, event, className }: Props) {
  if (!isMcpToolCall(toolName, toolSource, event)) return null

  const mcpArgs = extractMcpToolArgs(event)
  if (!mcpArgs) return null

  const json = formatMcpToolArgsBlock(mcpArgs)

  return (
    <details className={cn('tool-call-args', className)}>
      <summary className="tool-call-args__summary">args</summary>
      <pre className="tool-call-args__body">{json}</pre>
    </details>
  )
}
