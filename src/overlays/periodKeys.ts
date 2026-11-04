/**
 * Session-aware period keys for anchoring (VWAP, CPR, day open…), the
 * equivalent of Pine's `timeframe.change("D" | "W" | "M" | "3M" | "12M")` on
 * an exchange-session chart. A "day" is the symbol's trading day from
 * core/session.ts — 00:00 UTC by default, 18:00 New York for gold (so it
 * follows US daylight saving, and gold's Sunday-evening open is Monday).
 */
import { sessionClosedWeekends, sessionIndex, sessionOpenHourUTC, SESSION_DAY_MS } from '../core/session'

export interface PeriodKeys {
  /** Trading-day number (days since 1970-01-01 of the trading date). */
  day: Int32Array
  /** Monday-start week number. */
  week: Int32Array
  /** year * 12 + month (0-based). */
  month: Int32Array
  quarter: Int32Array
  year: Int32Array
  /** True on a Saturday/Sunday of a market that is shut at weekends (gold). */
  weekend: Uint8Array
}

/** Weekday of a trading-day number: 0 = Monday … 6 = Sunday. */
export const weekdayOf = (day: number): number => (((day + 3) % 7) + 7) % 7

export function computePeriodKeys(times: ArrayLike<number>, symbol: string): PeriodKeys {
  const n = times.length
  const out: PeriodKeys = {
    day: new Int32Array(n),
    week: new Int32Array(n),
    month: new Int32Array(n),
    quarter: new Int32Array(n),
    year: new Int32Array(n),
    weekend: new Uint8Array(n),
  }
  const closedWeekends = sessionClosedWeekends(symbol)
  let lastDay = NaN
  let m = 0
  let y = 0
  for (let i = 0; i < n; i++) {
    const t = times[i]
    const open = sessionOpenHourUTC(symbol, t)
    // a session that opens in the evening (gold: 22/23 UTC) belongs to the next calendar date
    const day = sessionIndex(t, open) + (open >= 12 ? 1 : 0)
    if (day !== lastDay) {
      lastDay = day
      const d = new Date(day * SESSION_DAY_MS)
      y = d.getUTCFullYear()
      m = d.getUTCMonth()
    }
    out.day[i] = day
    out.week[i] = Math.floor((day + 3) / 7)
    out.month[i] = y * 12 + m
    out.quarter[i] = y * 4 + Math.floor(m / 3)
    out.year[i] = y
    out.weekend[i] = closedWeekends && weekdayOf(day) >= 5 ? 1 : 0
  }
  return out
}
