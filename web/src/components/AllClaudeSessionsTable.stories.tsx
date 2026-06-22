import type { Meta, StoryObj } from '@storybook/react-vite'
import { AllClaudeSessionsTable } from './AllClaudeSessionsTable'
import { mockClaudeSessions } from '@/lib/mock-data'
import { withMobileFrame } from '@/lib/storybook-decorators'

const meta: Meta<typeof AllClaudeSessionsTable> = {
  title: 'components/AllClaudeSessionsTable',
  component: AllClaudeSessionsTable,
  args: {
    onRowClick: () => {},
  },
}

export default meta
type Story = StoryObj<typeof AllClaudeSessionsTable>

export const Populated: Story = {
  args: {
    rows: mockClaudeSessions,
    loading: false,
    noMatchAfterFilter: false,
    error: null,
  },
}

export const Loading: Story = {
  args: {
    rows: [],
    loading: true,
    noMatchAfterFilter: false,
    error: null,
  },
}

export const NoSessionsAtAll: Story = {
  args: {
    rows: [],
    loading: false,
    noMatchAfterFilter: false,
    error: null,
  },
}

export const NoMatchAfterFilter: Story = {
  args: {
    rows: [],
    loading: false,
    noMatchAfterFilter: true,
    error: null,
  },
}

export const Error: Story = {
  args: {
    rows: [],
    loading: false,
    noMatchAfterFilter: false,
    error: 'failed to scan ~/.claude/projects/: EACCES',
  },
}

export const Mobile: Story = {
  name: 'Mobile (375px)',
  decorators: [withMobileFrame],
  parameters: { layout: 'fullscreen' },
  args: {
    rows: mockClaudeSessions,
    loading: false,
    noMatchAfterFilter: false,
    error: null,
  },
}

export const MobileEmpty: Story = {
  name: 'Mobile · empty',
  decorators: [withMobileFrame],
  parameters: { layout: 'fullscreen' },
  args: {
    rows: [],
    loading: false,
    noMatchAfterFilter: false,
    error: null,
  },
}
