import { describe, expect, it } from 'vitest'
import { hasCompletedCodexTurn, readCodexMessagesFromRaw } from './codex-sessions.js'

const message = (timestamp: string, phase?: string, role = 'assistant') =>
  JSON.stringify({ timestamp, type: 'response_item', payload: {
    type: 'message', role, phase, content: [{ type: 'output_text', text: phase ?? role }],
  } })
const complete = (timestamp: string) => JSON.stringify({ timestamp, type: 'event_msg',
  payload: { type: 'task_complete', turn_id: timestamp } })

describe('Codex turn phases and completion', () => {
  it('preserves commentary without marking it as an end-turn reply', () => {
    const parsed = readCodexMessagesFromRaw([
      message('2026-10-12T10:00:00Z', 'commentary'),
      message('2026-10-12T10:00:01Z', 'final_answer'),
    ].join('\n'))
    expect(parsed.messages[0]).toMatchObject({ phase: 'commentary', stopReason: undefined })
    expect(parsed.messages[1]).toMatchObject({ phase: 'final_answer', stopReason: 'end_turn' })
    expect(hasCompletedCodexTurn(parsed, 0)).toBe(false)
  })

  it('keeps message IDs stable when the polling window drops older lines', () => {
    const first = message('2026-10-12T10:00:00Z', 'commentary')
    const second = message('2026-10-12T10:00:01Z', 'commentary')
    const full = readCodexMessagesFromRaw(first + '\n' + second)
    const tail = readCodexMessagesFromRaw(second)
    expect(tail.messages[0]?.uuid).toBe(full.messages[1]?.uuid)
  })

  it('ignores an earlier completion while the next turn is running', () => {
    const parsed = readCodexMessagesFromRaw([
      message('2026-10-12T10:00:00Z', 'final_answer'),
      complete('2026-10-12T10:00:01Z'),
      message('2026-10-12T10:00:02Z', undefined, 'user'),
      message('2026-10-12T10:00:03Z', 'commentary'),
    ].join('\n'))
    expect(hasCompletedCodexTurn(parsed, 0)).toBe(false)
    expect(hasCompletedCodexTurn(parsed, Date.parse('2026-10-12T10:00:01Z'))).toBe(false)
  })

  it('accepts a completed legacy reply and rejects a later unanswered user turn', () => {
    const raw = [message('2026-10-12T10:00:00Z'), complete('2026-10-12T10:00:01Z')].join('\n')
    expect(hasCompletedCodexTurn(readCodexMessagesFromRaw(raw), 0)).toBe(true)
    expect(hasCompletedCodexTurn(readCodexMessagesFromRaw(raw + '\n' +
      message('2026-10-12T10:00:02Z', undefined, 'user')), 0)).toBe(false)
  })
})


describe('Codex terminal failures', () => {
  const timestamp = '2026-10-13T05:44:49.958Z'
  const text = 'Selected model is at capacity. Please try a different model.'
  const failure = (error: unknown) => JSON.stringify({ timestamp, type: 'event_msg',
    payload: { type: 'task_complete', turn_id: 'failed-turn', error } })

  it.each([text, { message: text, codex_error_info: 'server_overloaded' }])(
    'exposes terminal errors as deduplicated error replies', error => {
      const record = failure(error)
      const parsed = readCodexMessagesFromRaw(record + '\n' + record)
      expect(parsed.messages).toHaveLength(1)
      expect(parsed.messages[0]).toMatchObject({ role: 'assistant', text, isError: true, stopReason: 'end_turn' })
      expect(hasCompletedCodexTurn(parsed, 0)).toBe(true)
      expect(hasCompletedCodexTurn(parsed, Date.parse(timestamp))).toBe(false)
    })

  it('does not replay a historical error after a new user message', () => {
    const parsed = readCodexMessagesFromRaw(failure({ message: text }) + '\n' +
      message('2026-10-13T05:45:00Z', undefined, 'user'))
    expect(hasCompletedCodexTurn(parsed, 0)).toBe(false)
  })
})


it('does not recover an old failure while a new task has started', () => {
  const raw = [
    JSON.stringify({ timestamp: '2026-10-13T05:44:49Z', type: 'event_msg', payload: {
      type: 'task_complete', error: { message: 'Selected model is at capacity.' } } }),
    JSON.stringify({ timestamp: '2026-10-13T05:45:00Z', type: 'event_msg', payload: { type: 'task_started' } }),
  ].join('\n')
  expect(hasCompletedCodexTurn(readCodexMessagesFromRaw(raw), 0)).toBe(false)
})
