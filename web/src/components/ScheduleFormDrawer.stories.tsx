import type { Meta, StoryObj } from '@storybook/react-vite'
import { Toaster } from 'sonner'
import { ScheduleFormDrawer } from './ScheduleFormDrawer'
import { mockOneOffSchedule, mockSchedule, mockTimezoneSchedule } from '@/lib/mock-data'

const meta: Meta<typeof ScheduleFormDrawer> = {
  title: 'components/ScheduleFormDrawer',
  component: ScheduleFormDrawer,
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
    onOpenChange: () => {},
    onSubmit: async () => {},
    defaultCwd: '/home/user/workspace',
  },
}

export default meta
type Story = StoryObj<typeof ScheduleFormDrawer>

export const Create: Story = {
  args: {
    editing: null,
  },
}

export const Edit: Story = {
  args: {
    editing: mockSchedule,
  },
}

export const EditOneOff: Story = {
  args: {
    editing: mockOneOffSchedule,
  },
}

export const EditTimezone: Story = {
  args: {
    editing: mockTimezoneSchedule,
  },
}
