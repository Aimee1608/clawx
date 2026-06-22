import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useTabRoute } from './useTabRoute'

function setHash(h: string): void {
  // jsdom requires going through location.hash to fire the hashchange event.
  window.location.hash = h
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

beforeEach(() => {
  // Reset location between tests so they don't interfere.
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('useTabRoute', () => {
  test('defaults to sessions:tmux when no hash', () => {
    const { result } = renderHook(() => useTabRoute())
    expect(result.current.tab).toBe('sessions:tmux')
  })

  test('parses two-segment #/sessions/<sub>', () => {
    setHash('#/sessions/claude')
    const { result: r1 } = renderHook(() => useTabRoute())
    expect(r1.current.tab).toBe('sessions:claude')
    setHash('#/sessions/codex')
    const { result: r2 } = renderHook(() => useTabRoute())
    expect(r2.current.tab).toBe('sessions:codex')
    setHash('#/sessions/room')
    const { result: r3 } = renderHook(() => useTabRoute())
    expect(r3.current.tab).toBe('sessions:room')
  })

  test('parses #/schedules', () => {
    setHash('#/schedules')
    const { result } = renderHook(() => useTabRoute())
    expect(result.current.tab).toBe('schedules')
  })

  test('legacy single-segment aliases still resolve', () => {
    setHash('#/tmux')
    const { result: r1 } = renderHook(() => useTabRoute())
    expect(r1.current.tab).toBe('sessions:tmux')
    setHash('#/all')
    const { result: r2 } = renderHook(() => useTabRoute())
    expect(r2.current.tab).toBe('sessions:claude')
    setHash('#/codex')
    const { result: r3 } = renderHook(() => useTabRoute())
    expect(r3.current.tab).toBe('sessions:codex')
  })

  test('legacy #/session/<uuid> falls back to sessions:claude tab', () => {
    setHash('#/session/9dd2bfef-ebdf-455f-be35-a80ee1326936')
    const { result } = renderHook(() => useTabRoute())
    expect(result.current.tab).toBe('sessions:claude')
  })

  test('unknown hash falls back to default (sessions:tmux)', () => {
    setHash('#/wat')
    const { result } = renderHook(() => useTabRoute())
    expect(result.current.tab).toBe('sessions:tmux')
  })

  test('unknown sub-tab under /sessions falls back to default sub-tab', () => {
    setHash('#/sessions/wat')
    const { result } = renderHook(() => useTabRoute())
    expect(result.current.tab).toBe('sessions:tmux')
  })

  test('setTab updates the hash and the returned value', () => {
    const { result } = renderHook(() => useTabRoute())
    act(() => {
      result.current.setTab('sessions:codex')
    })
    expect(window.location.hash).toBe('#/sessions/codex')
    expect(result.current.tab).toBe('sessions:codex')
  })

  test('setTab to schedules uses the single-segment hash', () => {
    const { result } = renderHook(() => useTabRoute())
    act(() => {
      result.current.setTab('schedules')
    })
    expect(window.location.hash).toBe('#/schedules')
    expect(result.current.tab).toBe('schedules')
  })

  test('reacts to external hashchange', () => {
    const { result } = renderHook(() => useTabRoute())
    expect(result.current.tab).toBe('sessions:tmux')
    act(() => {
      setHash('#/schedules')
    })
    expect(result.current.tab).toBe('schedules')
  })

  // Regression: opening the messages drawer from the Tmux tab pushes
  // `#/session/<uuid>` onto the hash. The PAGE-LOAD case treats that
  // as "show Sessions › Claude" (for shareable deep-links), but a
  // RUNTIME hashchange must keep the user on whichever tab they're on
  // — otherwise the tab silently switches behind the open drawer.
  test('#/session/<uuid> arriving via hashchange keeps current tab', () => {
    const { result } = renderHook(() => useTabRoute())
    act(() => {
      result.current.setTab('sessions:tmux')
    })
    expect(result.current.tab).toBe('sessions:tmux')
    act(() => {
      setHash('#/session/9dd2bfef-ebdf-455f-be35-a80ee1326936')
    })
    expect(result.current.tab).toBe('sessions:tmux') // unchanged
  })
})
