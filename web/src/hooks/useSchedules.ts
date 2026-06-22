import { useCallback } from 'react'
import { usePolling } from './usePolling'
import {
  api,
  type CreateScheduleBody,
  type Schedule,
  type ScheduleRunRecord,
  type SchedulesResponse,
  type UpdateScheduleBody,
} from '@/api'

export interface UseSchedulesResult {
  schedules: Schedule[]
  history: ScheduleRunRecord[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  create: (body: CreateScheduleBody) => Promise<Schedule>
  update: (id: string, body: UpdateScheduleBody) => Promise<Schedule>
  remove: (id: string) => Promise<void>
  runNow: (id: string) => Promise<void>
}

/**
 * Polling hook for the schedules tab. Fetches the list every 30s
 * (schedules don't change as fast as bot messages), exposes mutators
 * that refresh the list after each successful call.
 */
export function useSchedules(): UseSchedulesResult {
  const poll = usePolling<SchedulesResponse>({
    fetcher: () => api.schedules(),
    intervalMs: 30_000,
  })

  const refresh = useCallback(async () => {
    await poll.refresh()
  }, [poll])

  const create = useCallback(
    async (body: CreateScheduleBody): Promise<Schedule> => {
      const r = await api.createSchedule(body)
      await refresh()
      return r.schedule
    },
    [refresh],
  )

  const update = useCallback(
    async (id: string, body: UpdateScheduleBody): Promise<Schedule> => {
      const r = await api.updateSchedule(id, body)
      await refresh()
      return r.schedule
    },
    [refresh],
  )

  const remove = useCallback(
    async (id: string): Promise<void> => {
      await api.deleteSchedule(id)
      await refresh()
    },
    [refresh],
  )

  const runNow = useCallback(
    async (id: string): Promise<void> => {
      await api.runScheduleNow(id)
      // Wait a beat so the cron engine has time to update lastRunAt.
      setTimeout(() => void refresh(), 1500)
    },
    [refresh],
  )

  return {
    schedules: poll.data?.schedules ?? [],
    history: poll.data?.history ?? [],
    loading: poll.loading,
    error: poll.error,
    refresh,
    create,
    update,
    remove,
    runNow,
  }
}
