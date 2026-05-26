import { Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { ToolCallStatus } from '@/lib/tool-call-display'

type ToolCallHintProps = {
  label: string
  status: ToolCallStatus
  detail?: string
}

export function ToolCallHint({ label, status, detail }: ToolCallHintProps) {
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-1.5 py-0.5 pl-1 font-mono text-[10px] leading-4 text-text-secondary',
        status === 'running' && 'text-sky-300/90',
        status === 'completed' && 'text-text-secondary/90',
        status === 'failed' && 'text-red-300/90',
      )}
      title={detail ? `${label} · ${detail}` : label}
    >
      <span className="inline-flex w-3 shrink-0 items-center justify-center opacity-80">
        {status === 'running' ? (
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
        ) : status === 'failed' ? (
          <span aria-hidden>×</span>
        ) : (
          <span aria-hidden className="text-emerald-400/90">
            ›
          </span>
        )}
      </span>
      <span className="min-w-0 truncate">
        <span className="text-text-primary/75">{label}</span>
        {detail ? <span className="text-text-secondary/55"> {detail}</span> : null}
      </span>
    </div>
  )
}
