import { Check, Loader2, Terminal, Wrench, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { ToolCallStatus } from '@/lib/tool-call-display'

type ToolCallHintProps = {
  label: string
  status: ToolCallStatus
  detail?: string
}

export function ToolCallHint({ label, status, detail }: ToolCallHintProps) {
  const Icon = status === 'running' ? Loader2 : status === 'failed' ? X : Check
  const statusLabel =
    status === 'running' ? 'Running' : status === 'failed' ? 'Failed' : 'Done'

  return (
    <div
      className={cn(
        'mr-10 flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs',
        status === 'running' && 'border-sky-500/20 bg-sky-500/10 text-sky-100',
        status === 'completed' && 'border-emerald-500/20 bg-emerald-500/10 text-emerald-100',
        status === 'failed' && 'border-red-500/20 bg-red-500/10 text-red-200',
      )}
    >
      <span className="mt-0.5 inline-flex shrink-0 items-center justify-center rounded bg-black/20 p-1">
        {status === 'running' ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Icon className="h-3 w-3" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="inline-flex items-center gap-1 font-medium">
            <Wrench className="h-3 w-3 opacity-70" />
            {label}
          </span>
          <span className="text-[10px] uppercase tracking-wide opacity-70">{statusLabel}</span>
        </div>
        {detail ? (
          <p className="mt-0.5 truncate font-mono text-[11px] opacity-80" title={detail}>
            <Terminal className="mr-1 inline h-3 w-3 align-[-2px] opacity-60" />
            {detail}
          </p>
        ) : null}
      </div>
    </div>
  )
}
