import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

export interface MarkdownTextProps {
  text: string
  className?: string
}

/**
 * GitHub-flavored markdown renderer for assistant messages and
 * plan-card bodies. Tailwind utility classes give a compact, in-bubble
 * look — we deliberately do not use @tailwindcss/typography so the
 * styling stays explicit and predictable inside chat bubbles.
 */
export function MarkdownText({ text, className }: MarkdownTextProps): JSX.Element {
  return (
    <div className={cn('markdown-body break-words text-sm leading-relaxed', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Block-level
          p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
          h1: ({ children }) => (
            <h1 className="mb-2 mt-4 text-lg font-semibold first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-1.5 mt-3 text-base font-semibold first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-1 mt-3 text-sm font-semibold first:mt-0">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="mb-1 mt-2 text-sm font-semibold first:mt-0">{children}</h4>
          ),
          ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5">{children}</ol>,
          li: ({ children }) => <li className="leading-snug">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-current/30 pl-3 italic opacity-90">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-current/20" />,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2 hover:opacity-80"
            >
              {children}
            </a>
          ),

          // Inline + code
          code: (props) => {
            const { className: codeClassName, children, ...rest } = props as {
              className?: string
              children?: React.ReactNode
              inline?: boolean
            } & Record<string, unknown>
            // react-markdown v10 omits the `inline` prop; the heuristic below
            // (no language fence → inline) matches its default code-vs-pre
            // routing. The parent <pre> handles the block case.
            const isBlock = typeof codeClassName === 'string' && /language-/.test(codeClassName)
            if (isBlock) {
              return (
                <code className={cn('font-mono text-[12px]', codeClassName)} {...rest}>
                  {children}
                </code>
              )
            }
            return (
              <code
                className="rounded bg-current/10 px-1 py-px font-mono text-[12px]"
                {...rest}
              >
                {children}
              </code>
            )
          },
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded-md bg-current/10 p-2 font-mono text-[12px] leading-snug">
              {children}
            </pre>
          ),

          // Tables (gfm)
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="border-b border-current/30">{children}</thead>,
          th: ({ children }) => <th className="px-2 py-1 text-left font-semibold">{children}</th>,
          td: ({ children }) => (
            <td className="border-b border-current/10 px-2 py-1">{children}</td>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
