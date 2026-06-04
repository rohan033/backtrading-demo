import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { resolveMarkdownImageSrc } from '@/lib/workspaceMedia'
import { cn } from '@/lib/utils'

type ChatMarkdownProps = {
  content: string
  className?: string
}

export function ChatMarkdown({ content, className }: ChatMarkdownProps) {
  return (
    <div className={cn('chat-markdown break-words', className)}>
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
            <blockquote className="my-2 border-l-2 border-accent/40 pl-3 text-text-secondary italic">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline underline-offset-2 hover:text-accent/80"
            >
              {children}
            </a>
          ),
          strong: ({ children }) => <strong className="font-semibold text-text-primary">{children}</strong>,
          em: ({ children }) => <em className="italic text-text-primary/90">{children}</em>,
          hr: () => <hr className="my-3 border-border/60" />,
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto rounded-md border border-border/60">
              <table className="w-full min-w-[240px] border-collapse text-left text-xs">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-primary/80">{children}</thead>,
          tbody: ({ children }) => <tbody className="divide-y divide-border/40">{children}</tbody>,
          tr: ({ children }) => <tr>{children}</tr>,
          th: ({ children }) => (
            <th className="px-2 py-1.5 font-medium text-text-primary">{children}</th>
          ),
          td: ({ children }) => <td className="px-2 py-1.5 text-text-secondary">{children}</td>,
          img: ({ src, alt }) => {
            const resolved = resolveMarkdownImageSrc(typeof src === 'string' ? src : undefined)
            if (!resolved) return null
            return (
              <img
                src={resolved}
                alt={alt || ''}
                loading="lazy"
                className="my-2 max-h-72 w-full cursor-zoom-in rounded-md border border-border/60 object-contain"
              />
            )
          },
          code: ({ className: codeClassName, children, ...props }) => {
            const text = String(children).replace(/\n$/, '')
            const isBlock = Boolean(codeClassName) || text.includes('\n')

            if (isBlock) {
              return (
                <pre className="my-2 overflow-x-auto rounded-md border border-border/60 bg-[#0a1219] p-2.5 text-xs leading-relaxed">
                  <code className={cn('font-mono text-sky-200/90', codeClassName)} {...props}>
                    {text}
                  </code>
                </pre>
              )
            }

            return (
              <code
                className="rounded bg-[#0a1219] px-1 py-0.5 font-mono text-[0.85em] text-sky-200/90"
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
