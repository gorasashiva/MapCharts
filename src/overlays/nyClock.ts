// New York market clock for MAP V3 — shared by the browser and recorder/mapRecorder.mjs
// (Node strips the types, so this file has no imports).
//
// Every schedule is New York wall time (America/New_York through Intl), so US daylight
// saving is followed automatically: 08:15 ET is 12:15 UTC in summer and 13:15 UTC in winter.

const NY_TZ = 'America/New_York'
const DAY_MS = 86_400_000

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: NY_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

export interface NyParts {
  /** NY calendar date, YYYY-MM-DD. */
  date: string
  hour: number
  minute: number
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number
}

export function nyParts(ms: number): NyParts {
  const p: Record<string, string> = {}
  for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value
  const date = `${p.year}-${p.month}-${p.day}`
  return { date, hour: Number(p.hour), minute: Number(p.minute), weekday: weekdayOf(date) }
}

/** NY minus UTC, in minutes (−240 in summer, −300 in winter). */
export function nyOffsetMinutes(ms: number): number {
  const p: Record<string, string> = {}
  for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second))
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000)
}

/** Epoch ms of a New York wall-clock time on `date` (YYYY-MM-DD). */
export function nyTime(date: string, hour: number, minute = 0): number {
  const [y, m, d] = date.split('-').map(Number)
  const wall = Date.UTC(y, m - 1, d, hour, minute)
  let t = wall - nyOffsetMinutes(wall) * 60_000
  t = wall - nyOffsetMinutes(t) * 60_000 // second pass settles the day the clocks change
  return t
}

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

export const isNyWeekday = (date: string): boolean => {
  const w = weekdayOf(date)
  return w >= 1 && w <= 5
}

/** The weekday before `date` (Monday -> Friday). */
export function prevNyWeekday(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  let t = Date.UTC(y, m - 1, d) - DAY_MS
  while (![1, 2, 3, 4, 5].includes(new Date(t).getUTCDay())) t -= DAY_MS
  return new Date(t).toISOString().slice(0, 10)
}

/** The latest weekday on or before `date`. */
export function lastNyWeekday(date: string): string {
  return isNyWeekday(date) ? date : prevNyWeekday(date)
}

export type MapSnapshotKind = 'morning' | 'close'

/** Morning: after OCC publishes the day's open interest (the original MAP stamps ~08:23 ET). */
export const MORNING_ET = { hour: 8, minute: 15 }
/** Close: after the 16:00 ET options close, so the day's volume is complete. */
export const CLOSE_ET = { hour: 16, minute: 20 }
/** US options open; a morning snapshot taken after this is flagged late. */
export const OPEN_ET = { hour: 9, minute: 30 }

const mins = (h: number, m: number): number => h * 60 + m

export interface DueJob {
  kind: MapSnapshotKind
  nyDate: string
  /** Taken after its normal window (recorder was down / started late). */
  late: boolean
}

/**
 * Snapshots due at `now`, given the NY dates already captured per kind. Weekdays only; a
 * missed morning is still taken until the close (flagged late), a missed close until midnight.
 */
export function dueJobs(now: number, done: { morning?: string; close?: string }): DueJob[] {
  const p = nyParts(now)
  if (!isNyWeekday(p.date)) return []
  const t = mins(p.hour, p.minute)
  const out: DueJob[] = []
  if (done.morning !== p.date && t >= mins(MORNING_ET.hour, MORNING_ET.minute) && t < mins(CLOSE_ET.hour, CLOSE_ET.minute)) {
    out.push({ kind: 'morning', nyDate: p.date, late: t >= mins(OPEN_ET.hour, OPEN_ET.minute) })
  }
  if (done.close !== p.date && t >= mins(CLOSE_ET.hour, CLOSE_ET.minute)) {
    out.push({ kind: 'close', nyDate: p.date, late: t >= mins(CLOSE_ET.hour, CLOSE_ET.minute) + 120 })
  }
  return out
}

/** NY date of the session live at `now`: today after 08:15 ET on a weekday, else the last weekday's. */
export function sessionDate(now: number): string {
  const p = nyParts(now)
  if (!isNyWeekday(p.date)) return lastNyWeekday(p.date)
  return mins(p.hour, p.minute) >= mins(MORNING_ET.hour, MORNING_ET.minute) ? p.date : prevNyWeekday(p.date)
}

/** US equity-option expiry: 16:00 New York time on the expiry date. */
export const optionExpiryMs = (date: string): number => nyTime(date, 16, 0)
