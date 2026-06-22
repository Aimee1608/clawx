import * as React from 'react'

/**
 * Wraps a story in a 375px-wide phone-shaped frame. We use this inline
 * decorator instead of `@storybook/addon-viewport` to keep the addon list
 * minimal — the user can still see precisely how a component lays out at
 * iPhone width.
 *
 * The frame uses a subtle border so the story's actual width is visually
 * obvious (otherwise it just looks like a centered narrow column).
 */
export function MobileFrame({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex justify-center bg-muted/30 p-4">
      <div className="w-[375px] overflow-hidden rounded-lg border bg-background shadow-sm">
        {children}
      </div>
    </div>
  )
}

/** Convenience for `decorators: [withMobileFrame]` syntax. */
export const withMobileFrame = (Story: () => JSX.Element): JSX.Element => (
  <MobileFrame>
    <Story />
  </MobileFrame>
)
