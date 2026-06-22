import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { PaginationFooter } from './PaginationFooter'
import { withMobileFrame } from '@/lib/storybook-decorators'

const meta: Meta<typeof PaginationFooter> = {
  title: 'components/PaginationFooter',
  component: PaginationFooter,
  args: {
    pageSizeOptions: [25, 50, 100],
  },
}

export default meta
type Story = StoryObj<typeof PaginationFooter>

export const FirstPage: Story = {
  args: {
    page: 1,
    pageSize: 25,
    totalPages: 10,
    totalFiltered: 250,
    totalUnfiltered: 1125,
    onPageChange: () => {},
    onPageSizeChange: () => {},
  },
}

export const MiddlePage: Story = {
  args: {
    ...FirstPage.args!,
    page: 5,
  },
}

export const LastPage: Story = {
  args: {
    ...FirstPage.args!,
    page: 10,
  },
}

export const SinglePage: Story = {
  name: 'Single page (no filter)',
  args: {
    page: 1,
    pageSize: 25,
    totalPages: 1,
    totalFiltered: 7,
    totalUnfiltered: 7,
    pageSizeOptions: [25, 50, 100],
    onPageChange: () => {},
    onPageSizeChange: () => {},
  },
}

export const Mobile: Story = {
  name: 'Mobile (375px)',
  decorators: [withMobileFrame],
  parameters: { layout: 'fullscreen' },
  args: {
    page: 5,
    pageSize: 25,
    totalPages: 10,
    totalFiltered: 250,
    totalUnfiltered: 1125,
    pageSizeOptions: [25, 50, 100],
    onPageChange: () => {},
    onPageSizeChange: () => {},
  },
}

/** Interactive: state survives page+size changes inside the story. */
export const Interactive: Story = {
  render: (args) => {
    const Comp = (): JSX.Element => {
      const [page, setPage] = useState(1)
      const [pageSize, setPageSize] = useState(25)
      const totalPages = Math.max(1, Math.ceil(args.totalFiltered / pageSize))
      return (
        <PaginationFooter
          {...args}
          page={page}
          pageSize={pageSize}
          totalPages={totalPages}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      )
    }
    return <Comp />
  },
  args: {
    page: 1,
    pageSize: 25,
    totalPages: 5,
    totalFiltered: 110,
    totalUnfiltered: 1125,
    pageSizeOptions: [25, 50, 100],
    onPageChange: () => {},
    onPageSizeChange: () => {},
  },
}
