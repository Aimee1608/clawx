import * as React from 'react'
import { cn } from '@/lib/utils'

/** Skeleton placeholder block. Used in loading states instead of spinners
 * — gives the user a sense of layout before data arrives. */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />
}
