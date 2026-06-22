import type { Meta, StoryObj } from '@storybook/react-vite'
import { MessagesDrawer } from './MessagesDrawer'
import { mockMessages, mockMessagesWithError } from '@/lib/mock-data'

const meta: Meta<typeof MessagesDrawer> = {
  title: 'components/MessagesDrawer',
  component: MessagesDrawer,
  parameters: { layout: 'fullscreen' },
  args: {
    open: true,
    onOpenChange: () => {},
    subtitle: (
      <>
        Claude session <span className="font-mono text-xs">e4711656</span> · 4 turns ·{' '}
        <span className="font-mono text-xs">~/workspace/my-code/clawx</span>
      </>
    ),
  },
}

export default meta
type Story = StoryObj<typeof MessagesDrawer>

export const Populated: Story = {
  args: {
    messages: mockMessages,
    loading: false,
    error: null,
    note: null,
  },
}

export const Loading: Story = {
  args: {
    messages: [],
    loading: true,
    error: null,
    note: null,
  },
}

export const Error: Story = {
  args: {
    messages: [],
    loading: false,
    error: '404 session not tracked by this process',
    note: null,
  },
}

export const EmptyWithNote: Story = {
  args: {
    messages: [],
    loading: false,
    error: null,
    note: 'jsonl not found (session may have no turns yet)',
  },
}

export const WithErrorTurn: Story = {
  args: {
    messages: mockMessagesWithError,
    loading: false,
    error: null,
    note: null,
  },
}

/** Long thread to demo the floating jump-to-top / jump-to-bottom buttons.
 * Open the story, scroll mid-way, and the up + down chevrons should both
 * appear at the right edge. */
export const LongScroll: Story = {
  args: {
    messages: Array.from({ length: 30 }).flatMap((_, i) => [
      {
        role: 'user' as const,
        text: `Question #${i + 1}: how do I refactor handler ${i + 1} to use the new API surface?`,
        timestamp: new Date(Date.now() - (30 - i) * 60_000).toISOString(),
        uuid: `u-${i}`,
      },
      {
        role: 'assistant' as const,
        text:
          `Here's the plan for #${i + 1}:\n` +
          `1. Identify the call sites of the legacy handler.\n` +
          `2. Introduce a thin adapter that maps to the new API.\n` +
          `3. Migrate one call site at a time, running the test suite.\n` +
          `4. Remove the legacy handler when adapter usage drops to zero.`,
        timestamp: new Date(Date.now() - (30 - i) * 60_000 + 2000).toISOString(),
        uuid: `a-${i}`,
      },
    ]),
    loading: false,
    error: null,
    note: null,
  },
}
