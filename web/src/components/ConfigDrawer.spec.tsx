import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { ConfigDrawer } from './ConfigDrawer'

test('shows the configured default and submits an explicit agent selection', async () => {
  const submit = vi.fn(async () => {})
  render(<ConfigDrawer open cfg={{ path: '/tmp/config.json', config: {
    defaultAgent: 'codex', larkAppSecret: { preview: '', set: false },
  } }} saving={false} onOpenChange={() => {}} onSubmit={submit} />)
  const select = screen.getByLabelText('Default agent')
  expect(select).toHaveValue('codex')
  await userEvent.selectOptions(select, 'claude')
  await userEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(submit).toHaveBeenCalledWith({ defaultAgent: 'claude' }))
})
