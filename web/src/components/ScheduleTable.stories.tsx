import type { Meta, StoryObj } from '@storybook/react-vite'
import { Toaster } from 'sonner'
import { ScheduleTable } from './ScheduleTable'
import { mockSchedules } from '@/lib/mock-data'
import { withMobileFrame } from '@/lib/storybook-decorators'

const meta: Meta<typeof ScheduleTable> = {
  title: 'components/ScheduleTable',
  component: ScheduleTable,
  decorators: [
    (Story) => (
      <div>
        <Story />
        <Toaster position="top-right" richColors />
      </div>
    ),
  ],
  args: {
    onEdit: () => {},
    onToggle: () => {},
    onDelete: () => {},
    onRunNow: () => {},
  },
}

export default meta
type Story = StoryObj<typeof ScheduleTable>

export const Populated: Story = {
  args: {
    schedules: mockSchedules,
    loading: false,
  },
}

export const Empty: Story = {
  args: {
    schedules: [],
    loading: false,
  },
}

export const Loading: Story = {
  args: {
    schedules: [],
    loading: true,
  },
}

export const Mobile: Story = {
  name: 'Mobile (375px)',
  decorators: [withMobileFrame],
  parameters: { layout: 'fullscreen' },
  args: {
    schedules: mockSchedules,
    loading: false,
  },
}
