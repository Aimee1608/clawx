import type { Meta, StoryObj } from '@storybook/react-vite'
import { Toaster } from 'sonner'
import { ConfigDrawer } from './ConfigDrawer'
import { mockConfigEmpty, mockConfigPartial } from '@/lib/mock-data'

const meta: Meta<typeof ConfigDrawer> = {
  title: 'components/ConfigDrawer',
  component: ConfigDrawer,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div>
        <Story />
        <Toaster position="top-right" richColors />
      </div>
    ),
  ],
  args: {
    open: true,
    saving: false,
    onOpenChange: () => {},
    onSubmit: async () => {},
  },
}

export default meta
type Story = StoryObj<typeof ConfigDrawer>

export const FreshUser: Story = {
  name: 'No config file yet',
  args: {
    cfg: mockConfigEmpty,
  },
}

export const PartiallyConfigured: Story = {
  name: 'Hub mode set, WS not',
  args: {
    cfg: mockConfigPartial,
  },
}

export const Saving: Story = {
  args: {
    cfg: mockConfigPartial,
    saving: true,
  },
}

export const Loading: Story = {
  name: 'Config not loaded yet',
  args: {
    cfg: null,
  },
}
