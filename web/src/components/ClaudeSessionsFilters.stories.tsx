import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { ClaudeSessionsFilters, type TimeFilter } from './ClaudeSessionsFilters'
import { withMobileFrame } from '@/lib/storybook-decorators'

const meta: Meta<typeof ClaudeSessionsFilters> = {
  title: 'components/ClaudeSessionsFilters',
  component: ClaudeSessionsFilters,
}

export default meta
type Story = StoryObj<typeof ClaudeSessionsFilters>

export const Default7d: Story = {
  args: {
    timeFilter: '7d',
    search: '',
    onTimeFilterChange: () => {},
    onSearchChange: () => {},
  },
}

export const All: Story = {
  args: {
    timeFilter: 'all',
    search: '',
    onTimeFilterChange: () => {},
    onSearchChange: () => {},
  },
}

export const WithSearch: Story = {
  args: {
    timeFilter: '24h',
    search: 'refactor',
    onTimeFilterChange: () => {},
    onSearchChange: () => {},
  },
}

export const Mobile: Story = {
  name: 'Mobile (375px)',
  decorators: [withMobileFrame],
  parameters: { layout: 'fullscreen' },
  render: () => {
    const Comp = (): JSX.Element => {
      const [time, setTime] = useState<TimeFilter>('7d')
      const [search, setSearch] = useState('')
      return (
        <div className="p-4">
          <ClaudeSessionsFilters
            timeFilter={time}
            search={search}
            onTimeFilterChange={setTime}
            onSearchChange={setSearch}
          />
        </div>
      )
    }
    return <Comp />
  },
}

/** Interactive: filter chip + search are wired to local state. */
export const Interactive: Story = {
  render: () => {
    const Comp = (): JSX.Element => {
      const [time, setTime] = useState<TimeFilter>('7d')
      const [search, setSearch] = useState('')
      return (
        <ClaudeSessionsFilters
          timeFilter={time}
          search={search}
          onTimeFilterChange={setTime}
          onSearchChange={setSearch}
        />
      )
    }
    return <Comp />
  },
}
