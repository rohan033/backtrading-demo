import { useState } from 'react'
import { Expand, X } from 'lucide-react'

import {
  mergeAttachments,
  workspaceMediaUrl,
  type ChatMediaAttachment,
} from '@/lib/workspaceMedia'
import { cn } from '@/lib/utils'

type ChatMediaGalleryProps = {
  attachments?: ChatMediaAttachment[]
  className?: string
}

function MediaTile({
  attachment,
  onExpand,
}: {
  attachment: ChatMediaAttachment
  onExpand: () => void
}) {
  const src = workspaceMediaUrl(attachment.path)
  const label = attachment.label || attachment.path.split('/').pop() || 'Media'

  if (attachment.kind === 'video') {
    return (
      <figure className="overflow-hidden rounded-lg border border-border/70 bg-[#0a1219]">
        <video
          src={src}
          controls
          playsInline
          loop={attachment.kind === 'animation'}
          className="max-h-72 w-full object-contain"
        />
        <figcaption className="border-t border-border/50 px-2 py-1 text-[10px] text-text-secondary">
          {label}
        </figcaption>
      </figure>
    )
  }

  return (
    <figure className="group relative overflow-hidden rounded-lg border border-border/70 bg-[#0a1219]">
      <img
        src={src}
        alt={label}
        loading="lazy"
        className="max-h-72 w-full cursor-zoom-in object-contain"
        onClick={onExpand}
      />
      <button
        type="button"
        aria-label={`Expand ${label}`}
        onClick={onExpand}
        className="absolute top-2 right-2 rounded-md border border-border/60 bg-card/90 p-1 text-text-secondary opacity-0 transition-opacity group-hover:opacity-100"
      >
        <Expand className="h-3.5 w-3.5" />
      </button>
      <figcaption className="border-t border-border/50 px-2 py-1 text-[10px] text-text-secondary">
        {label}
      </figcaption>
    </figure>
  )
}

export function ChatMediaGallery({ attachments = [], className }: ChatMediaGalleryProps) {
  const items = mergeAttachments(attachments)
  const [expanded, setExpanded] = useState<ChatMediaAttachment | null>(null)

  if (!items.length) return null

  return (
    <>
      <div
        className={cn(
          'mt-3 grid gap-2',
          items.length > 1 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1',
          className,
        )}
      >
        {items.map(item => (
          <MediaTile
            key={item.path}
            attachment={item}
            onExpand={() => setExpanded(item)}
          />
        ))}
      </div>

      {expanded ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label="Expanded media"
          onClick={() => setExpanded(null)}
        >
          <button
            type="button"
            aria-label="Close"
            onClick={() => setExpanded(null)}
            className="absolute top-4 right-4 rounded-md border border-border/60 bg-card/90 p-2 text-text-primary"
          >
            <X className="h-4 w-4" />
          </button>
          <div
            className="max-h-[90vh] max-w-[min(96vw,1100px)] overflow-auto"
            onClick={event => event.stopPropagation()}
          >
            {expanded.kind === 'video' ? (
              <video
                src={workspaceMediaUrl(expanded.path)}
                controls
                autoPlay
                playsInline
                className="max-h-[85vh] w-full rounded-lg"
              />
            ) : (
              <img
                src={workspaceMediaUrl(expanded.path)}
                alt={expanded.label || expanded.path}
                className="max-h-[85vh] w-full rounded-lg object-contain"
              />
            )}
          </div>
        </div>
      ) : null}
    </>
  )
}

export default ChatMediaGallery
