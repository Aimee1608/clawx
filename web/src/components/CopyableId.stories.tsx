import type { Meta, StoryObj } from '@storybook/react-vite'
import { Toaster } from 'sonner'
import { CopyableId } from './CopyableId'

const meta: Meta<typeof CopyableId> = {
  title: 'components/CopyableId',
  component: CopyableId,
  decorators: [
    (Story) => (
      <div>
        <Story />
        <Toaster position="top-right" richColors />
      </div>
    ),
  ],
  args: {
    label: 'session id',
  },
}

export default meta
type Story = StoryObj<typeof CopyableId>

export const Short: Story = {
  args: { value: 'e4711656-da38-4a6d-84d5-a579f270dfd0' },
}

export const Long: Story = {
  args: {
    value: 'oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx:user@example.com',
    label: 'chat id',
  },
}
