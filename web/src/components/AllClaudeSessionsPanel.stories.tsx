import type { Meta, StoryObj } from '@storybook/react-vite'
import { AllClaudeSessionsPanel } from './AllClaudeSessionsPanel'
import { mockClaudeSessions } from '@/lib/mock-data'
import { withMobileFrame } from '@/lib/storybook-decorators'

// Build a slightly larger pool so pagination has something to page through.
const manyClaudeSessions = [
  ...mockClaudeSessions,
  ...Array.from({ length: 50 }).map((_, i) => ({
    uuid: `dddd${i.toString().padStart(4, '0')}-1111-2222-3333-444444444444`,
    projectDir: `-tmp-other-${i}`,
    cwd: `/tmp/other-${i}`,
    entrypoint: i % 2 === 0 ? 'cli' : 'sdk-cli',
    firstPrompt: `synthetic prompt #${i}: rewrite this thing in TypeScript`,
    firstTs: new Date(Date.now() - (i + 1) * 3600_000).toISOString(),
    lastModified: new Date(Date.now() - i * 1800_000).toISOString(),
    sizeBytes: 1024 * (i + 1),
    inBot: false,
  })),
]

const meta: Meta<typeof AllClaudeSessionsPanel> = {
  title: 'components/AllClaudeSessionsPanel',
  component: AllClaudeSessionsPanel,
  args: {
    onRowClick: () => {},
  },
}

export default meta
type Story = StoryObj<typeof AllClaudeSessionsPanel>

export const Populated: Story = {
  args: {
    sessions: mockClaudeSessions,
    loading: false,
    error: null,
  },
}

export const ManyPages: Story = {
  args: {
    sessions: manyClaudeSessions,
    loading: false,
    error: null,
    defaultTimeFilter: 'all',
  },
}

export const Loading: Story = {
  args: {
    sessions: [],
    loading: true,
    error: null,
  },
}

export const Empty: Story = {
  args: {
    sessions: [],
    loading: false,
    error: null,
  },
}

export const Error: Story = {
  args: {
    sessions: [],
    loading: false,
    error: 'permission denied',
  },
}

export const Mobile: Story = {
  name: 'Mobile (375px)',
  decorators: [withMobileFrame],
  parameters: { layout: 'fullscreen' },
  args: {
    sessions: manyClaudeSessions,
    loading: false,
    error: null,
    defaultTimeFilter: 'all',
  },
}
