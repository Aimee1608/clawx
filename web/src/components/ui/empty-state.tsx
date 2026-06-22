import * as React from 'react'
import { cn } from '@/lib/utils'

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode
  title: string
  description?: React.ReactNode
}

/**
 * Centered icon + heading + description for "nothing here" states.
 * Designed to feel intentional rather than broken — picks a softer mood
 * than a row of "loading…" text.
 */
export function EmptyState({ icon, title, description, className, ...props }: EmptyStateProps): JSX.Element {
  return (
    <div className={cn('flex flex-col items-center gap-2 px-6 py-12 text-center', className)} {...props}>
      {icon ? <div className="text-muted-foreground/60">{icon}</div> : null}
      <div className="text-sm font-medium text-foreground">{title}</div>
      {description ? (
        <div className="max-w-sm text-xs leading-relaxed text-muted-foreground">{description}</div>
      ) : null}
    </div>
  )
}
