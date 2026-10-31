/**
 * CPR & floor-pivot math, kept free of DOM/engine code so it can be unit
 * tested. Bars are grouped into Day / Week / Month periods (UTC, shifted by a
 * session start hour) and each period's levels come from the period before it.
 */

export type CprTimeframe = 'day' | 'week' | 'month'
export type PivotType = 'traditional' | 'classic'

export interface OHLCBar {
  time: number
  open: number
  high: number
  low: number
  close: number
}

export interface Period {
  start: number // epoch ms, inclusive
  end: number // epoch ms, exclusive
  open: number
  high: number
  low: number
  close: number
}

export interface PivotLevels {
  pivot: number
  tc: number // top central — always >= bc
  bc: number // bottom central
  r: [number, number, number, number] // R1..R4
  s: [number, number, number, number] // S1..S4
  prevHigh: number
  prevLow: number
  /** (TC − BC) as a fraction of the pivot — a narrow CPR hints at a trending session. */
  width: number
}

export interface PeriodLevels extends PivotLevels {
  start: number
  end: number
}

export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

/** Most hours of 1h data one period spans — sizes history requests. */
export const PERIOD_HOURS: Record<CprTimeframe, number> = { day: 24, week: 168, month: 744 }

/**
 * [start, end) of the period containing `t`. Weeks start Monday; months on the 1st.
 * A session is dated by the calendar day it mostly covers, so one opening at
 * 22:00 UTC belongs to the next day (gold's Sunday 22:00 open is Monday).
 */
export function periodBounds(t: number, tf: CprTimeframe, startHourUTC: number): [number, number] {
  const shift = startHourUTC * HOUR_MS
  const dayStart = Math.floor((t - shift) / DAY_MS) * DAY_MS + shift
  if (tf === 'day') return [dayStart, dayStart + DAY_MS]
  const date = Math.floor((dayStart + DAY_MS / 2) / DAY_MS) * DAY_MS // UTC midnight of the session's day
  const sessionOf = (d: number): number => d + shift - (startHourUTC >= 12 ? DAY_MS : 0) // open of the session dated d
  if (tf === 'week') {
    const monday = date - ((date / DAY_MS + 3) % 7) * DAY_MS // 1970-01-01 was a Thursday
    return [sessionOf(monday), sessionOf(monday + 7 * DAY_MS)]
  }
  const d = new Date(date)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  return [sessionOf(Date.UTC(y, m, 1)), sessionOf(Date.UTC(y, m + 1, 1))]
}

/** Aggregate ascending bars into consecutive periods (gaps simply produce no period). */
export function buildPeriods(bars: OHLCBar[], tf: CprTimeframe, startHourUTC: number): Period[] {
  const out: Period[] = []
  let cur: Period | null = null
  for (const b of bars) {
    if (!cur || b.time >= cur.end || b.time < cur.start) {
      const [start, end] = periodBounds(b.time, tf, startHourUTC)
      cur = { start, end, open: b.open, high: b.high, low: b.low, close: b.close }
      out.push(cur)
      continue
    }
    if (b.high > cur.high) cur.high = b.high
    if (b.low < cur.low) cur.low = b.low
    cur.close = b.close
  }
  return out
}

/** Levels for the period after `prev`. Traditional matches TradingView's "Pivot Points Standard". */
export function pivotLevels(prev: Pick<Period, 'high' | 'low' | 'close'>, type: PivotType = 'traditional'): PivotLevels {
  const { high: h, low: l, close: c } = prev
  const p = (h + l + c) / 3
  const mid = (h + l) / 2
  const other = 2 * p - mid
  const range = h - l
  const r1 = 2 * p - l
  const s1 = 2 * p - h
  const r2 = p + range
  const s2 = p - range
  let r3: number, s3: number, r4: number, s4: number
  if (type === 'classic') {
    r3 = p + 2 * range
    s3 = p - 2 * range
    r4 = p + 3 * range
    s4 = p - 3 * range
  } else {
    r3 = h + 2 * (p - l)
    s3 = l - 2 * (h - p)
    r4 = 3 * p + (h - 3 * l)
    s4 = 3 * p - (3 * h - l)
  }
  const tc = Math.max(mid, other)
  const bc = Math.min(mid, other)
  return { pivot: p, tc, bc, r: [r1, r2, r3, r4], s: [s1, s2, s3, s4], prevHigh: h, prevLow: l, width: p ? (tc - bc) / p : 0 }
}

/** True when the day session containing `t` is dated Saturday or Sunday. */
export function isWeekendSession(t: number, startHourUTC: number): boolean {
  const [dayStart] = periodBounds(t, 'day', startHourUTC)
  const wd = (Math.floor((dayStart + DAY_MS / 2) / DAY_MS) + 4) % 7 // 0 = Sunday
  return wd === 0 || wd === 6
}

/**
 * Levels for the last `count` periods ending with the one containing `anchor`
 * (the latest chart bar, so replay never sees levels from its future). A
 * period is skipped when the period before it has no data.
 *
 * `skipWeekends` (markets closed Sat/Sun, e.g. gold): weekend bars are left
 * out of every period, Monday's levels come from Friday, and no levels are
 * drawn for weekend sessions.
 */
export function computeLevels(
  bars: OHLCBar[],
  tf: CprTimeframe,
  startHourUTC: number,
  count: number,
  anchor: number,
  type: PivotType = 'traditional',
  skipWeekends = false,
): PeriodLevels[] {
  const src = skipWeekends ? bars.filter((b) => !isWeekendSession(b.time, startHourUTC)) : bars
  const byStart = new Map(buildPeriods(src, tf, startHourUTC).map((p) => [p.start, p]))
  const out: PeriodLevels[] = []
  let [start, end] = periodBounds(anchor, tf, startHourUTC)
  // Day periods step over the weekend: up to 3 sessions back to reach Friday from Monday.
  const back = (from: number): number => {
    let s = periodBounds(from - 1, tf, startHourUTC)[0]
    for (let j = 0; skipWeekends && tf === 'day' && j < 2 && isWeekendSession(s, startHourUTC); j++) s = periodBounds(s - 1, tf, startHourUTC)[0]
    return s
  }
  // Anchored on a closed weekend session: the last session drawn is Friday's.
  if (skipWeekends && tf === 'day' && isWeekendSession(start, startHourUTC)) {
    start = back(start)
    end = periodBounds(start, tf, startHourUTC)[1]
  }
  for (let i = 0; i < count; i++) {
    const prevStart = back(start)
    const prev = byStart.get(prevStart)
    if (prev) out.push({ start, end, ...pivotLevels(prev, type) })
    end = periodBounds(prevStart, tf, startHourUTC)[1]
    start = prevStart
  }
  return out.reverse()
}
