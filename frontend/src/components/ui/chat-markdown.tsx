import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { resolveMarkdownImageSrc } from '@/lib/workspaceMedia'
import { cn } from '@/lib/utils'

type ChatMarkdownVariant = 'dark' | 'light'

type ChatMarkdownProps = {
  content: string
  className?: string
  /** Light panels (Home research drawer) need explicit dark text — not theme tokens. */
  variant?: ChatMarkdownVariant
}

const VARIANT_ROOT: Record<ChatMarkdownVariant, string> = {
  dark: 'chat-markdown--dark',
  light: 'chat-markdown--light',
}

export function ChatMarkdown({ content, className, variant = 'dark' }: ChatMarkdownProps) {
  const isLight = variant === 'light'

  return (
    <div className={cn('chat-markdown break-words', VARIANT_ROOT[variant], className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          h1: ({ children }) => (
            <h1 className="mt-3 mb-2 text-base font-semibold first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-3 mb-2 text-sm font-semibold first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-2 mb-1 text-sm font-medium first:mt-0">{children}</h3>
          ),
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote
              className={cn(
                'my-2 border-l-2 pl-3 italic',
                isLight
                  ? 'border-[#C8C8C8] text-[#4a5568]'
                  : 'border-accent/40 text-text-secondary',
              )}
            >
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'underline underline-offset-2',
                isLight ? 'text-[#2A5F9E] hover:text-[#1E4A7A]' : 'text-accent hover:text-accent/80',
              )}
            >
              {children}
            </a>
          ),
          strong: ({ children }) => (
            <strong className={cn('font-semibold', !isLight && 'text-text-primary')}>{children}</strong>
          ),
          em: ({ children }) => (
            <em className={cn('italic', !isLight && 'text-text-primary/90')}>{children}</em>
          ),
          hr: () => (
            <hr className={cn('my-3', isLight ? 'border-[#D8D8D8]' : 'border-border/60')} />
          ),
          table: ({ children }) => (
            <div
              className={cn(
                'my-2 overflow-x-auto rounded-md border',
                isLight ? 'border-[#D8D8D8]' : 'border-border/60',
              )}
            >
              <table className="w-full min-w-[240px] border-collapse text-left text-xs">{children}</table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className={isLight ? 'bg-[#EFEFEF]' : 'bg-primary/80'}>{children}</thead>
          ),
          tbody: ({ children }) => (
            <tbody className={cn('divide-y', isLight ? 'divide-[#E5E5E5]' : 'divide-border/40')}>
              {children}
            </tbody>
          ),
          tr: ({ children }) => <tr>{children}</tr>,
          th: ({ children }) => (
            <th className={cn('px-2 py-1.5 font-medium', !isLight && 'text-text-primary')}>{children}</th>
          ),
          td: ({ children }) => (
            <td className={cn('px-2 py-1.5', !isLight && 'text-text-secondary')}>{children}</td>
          ),
          img: ({ src, alt }) => {
            const resolved = resolveMarkdownImageSrc(typeof src === 'string' ? src : undefined)
            if (!resolved) return null
            return (
              <img
                src={resolved}
                alt={alt || ''}
                loading="lazy"
                className={cn(
                  'my-2 max-h-72 w-full cursor-zoom-in rounded-md border object-contain',
                  isLight ? 'border-[#D8D8D8]' : 'border-border/60',
                )}
              />
            )
          },
          code: ({ className: codeClassName, children, ...props }) => {
            const text = String(children).replace(/\n$/, '')
            const isBlock = Boolean(codeClassName) || text.includes('\n')

            if (isBlock) {
              return (
                <pre
                  className={cn(
                    'my-2 overflow-x-auto rounded-md border p-2.5 text-xs leading-relaxed',
                    isLight
                      ? 'border-[#D8D8D8] bg-[#EFEFEF] text-[#111]'
                      : 'border-border/60 bg-[#0a1219]',
                  )}
                >
                  <code
                    className={cn('font-mono', !isLight && 'text-sky-200/90', codeClassName)}
                    {...props}
                  >
                    {text}
                  </code>
                </pre>
              )
            }

            return (
              <code
                className={cn(
                  'rounded px-1 py-0.5 font-mono text-[0.85em]',
                  isLight ? 'bg-[#ECECEC] text-[#111]' : 'bg-[#0a1219] text-sky-200/90',
                )}
                {...props}
              >
                {children}
              </code>
            )
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

export default ChatMarkdown
