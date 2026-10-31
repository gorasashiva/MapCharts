import { describe, expect, it } from 'vitest'
import { dueJobs, nyParts, nyTime, optionExpiryMs, prevNyWeekday, sessionDate } from './nyClock'

const utc = (s: string): number => Date.parse(`${s}Z`)

describe('New York clock (US daylight saving followed automatically)', () => {
  it('08:15 ET is 12:15 UTC in summer time and 13:15 UTC in winter time', () => {
    expect(nyTime('2026-10-29', 8, 15)).toBe(utc('2026-10-29T12:15:00'))
    expect(nyTime('2026-11-02', 8, 15)).toBe(utc('2026-11-02T13:15:00')) // clocks went back 1 Nov 2026
    expect(nyTime('2026-03-06', 8, 15)).toBe(utc('2026-03-06T13:15:00'))
    expect(nyTime('2026-03-09', 8, 15)).toBe(utc('2026-03-09T12:15:00')) // clocks went forward 8 Mar 2026
    expect(nyTime('2026-03-08', 3, 0)).toBe(utc('2026-03-08T07:00:00')) // the change day itself
  })

  it('option expiry is 16:00 ET either side of the change', () => {
    expect(optionExpiryMs('2026-10-30')).toBe(utc('2026-10-30T20:00:00'))
    expect(optionExpiryMs('2026-11-06')).toBe(utc('2026-11-06T21:00:00'))
  })

  it('nyParts reads the New York date / time', () => {
    expect(nyParts(utc('2026-10-30T02:00:00'))).toMatchObject({ date: '2026-10-29', hour: 22, minute: 0, weekday: 4 })
  })

  it('schedules the morning and close snapshots on NY time, weekdays only', () => {
    expect(dueJobs(utc('2026-10-29T12:14:00'), {})).toEqual([])
    expect(dueJobs(utc('2026-10-29T12:16:00'), {})).toEqual([{ kind: 'morning', nyDate: '2026-10-29', late: false }])
    expect(dueJobs(utc('2026-10-29T12:16:00'), { morning: '2026-10-29' })).toEqual([])
    expect(dueJobs(utc('2026-10-29T14:00:00'), {})[0]).toMatchObject({ kind: 'morning', late: true }) // after the 09:30 open
    expect(dueJobs(utc('2026-10-29T20:21:00'), { morning: '2026-10-29' })).toEqual([{ kind: 'close', nyDate: '2026-10-29', late: false }])
    // winter: 08:15 ET = 13:15 UTC
    expect(dueJobs(utc('2026-11-02T13:10:00'), { morning: '2026-10-30' })).toEqual([])
    expect(dueJobs(utc('2026-11-02T13:16:00'), { morning: '2026-10-30' })).toEqual([{ kind: 'morning', nyDate: '2026-11-02', late: false }])
    expect(dueJobs(utc('2026-10-31T15:00:00'), {})).toEqual([]) // Saturday
  })

  it('session date: before 08:15 ET and at weekends it is the last weekday', () => {
    expect(sessionDate(utc('2026-11-02T11:00:00'))).toBe('2026-10-30') // Mon 06:00 ET
    expect(sessionDate(utc('2026-11-02T14:00:00'))).toBe('2026-11-02')
    expect(sessionDate(utc('2026-10-31T15:00:00'))).toBe('2026-10-30') // Saturday
    expect(prevNyWeekday('2026-11-02')).toBe('2026-10-30')
  })
})
