import { cn } from '@/lib/utils'

type ChatTypingDotsProps = {
  className?: string
}

export function ChatTypingDots({ className }: ChatTypingDotsProps) {
  return (
    <span className={cn('inline-flex items-center gap-1 py-0.5', className)} aria-label="Waiting for response">
      {[0, 150, 300].map(delay => (
        <span
          key={delay}
          className="chat-typing-dot inline-block h-1.5 w-1.5 rounded-full bg-text-secondary"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  )
}

export default ChatTypingDots
