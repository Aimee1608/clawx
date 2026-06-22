import type { Meta, StoryObj } from '@storybook/react-vite'
import { TopBar } from './TopBar'
import { mockStatus, mockStatusWs } from '@/lib/mock-data'
import { withMobileFrame } from '@/lib/storybook-decorators'

const meta: Meta<typeof TopBar> = {
  title: 'components/TopBar',
  component: TopBar,
  parameters: { layout: 'fullscreen' },
  args: {
    onOpenConfig: () => {},
  },
}

export default meta
type Story = StoryObj<typeof TopBar>

export const HubLoaded: Story = {
  args: {
    status: mockStatus,
    user: 'user@example.com',
  },
}

export const WsLoaded: Story = {
  args: {
    status: mockStatusWs,
    user: 'user@example.com',
  },
}

export const Loading: Story = {
  args: {
    status: null,
    user: null,
  },
}

export const NoUserResolved: Story = {
  name: 'Hub mode, no user resolved yet',
  args: {
    status: mockStatus,
    user: null,
  },
}

export const Mobile: Story = {
  name: 'Mobile (375px)',
  decorators: [withMobileFrame],
  args: {
    status: mockStatus,
    user: 'user@example.com',
  },
}
