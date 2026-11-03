/**
 * Flying CPR Signals — port of "Flying CPR.pine" (Pine v6).
 *
 * Opening range: the high / low of the 09:31–09:59 window (session timezone,
 * default Asia/Kolkata), reset daily at 09:30. Fibonacci extensions of that
 * range at ±2.07, 2.57, 4.07, 4.57, 10.07, 10.57 above the high / below the low.
 *
 * Signals (each gated by the time-of-day / day-of-week filters):
 *   A  Range Breakout — narrow range (range / ATR14 <= narrowRange), wide-body close across SH / SL
 *   B  Fib Rejection  — wick past F2.07 / F2.57 by buf, close back inside with an opposite body
 *   C  NY-Reversal Fade — 13:00–15:00 UTC, wick to F2.57 / F4.57, close back inside, volume > avg × volMult
 *   D  Extreme Capitulation — wick past F4.57 / F10.07 by buf, close back inside, volume > avg × capVolMult
 *
 * Pine reads the range from 1-minute bars (request.security "1"). Here it comes
 * from the chart's own bars: a bar counts toward the range when any minute of it
 * falls in the window, so it is exact on 1m and close on 3m / 5m (the 09:30 bar's
 * first minute is included). Session times are wall-clock in the chosen zone, so
 * London / New York follow daylight saving.
 *
 * Pure — no DOM / engine. No look-ahead: bar i uses bars <= i only.
 */

import { localClock, type SessTz } from './sessionsModel'

export interface FcBar {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export const FC_RATIOS = [2.07, 2.57, 4.07, 4.57, 10.07, 10.57] as const

export interface FlyingCprOptions {
  tz: SessTz
  /** Local minutes of day, both inclusive (Pine: 09:31 .. 09:59). */
  sessStart: number
  sessEnd: number
  /** Local minute of day the range and extensions reset. */
  reset: number
  useA: boolean
  useB: boolean
  useC: boolean
  useD: boolean
  wideBodyATR: number
  narrowRange: number
  fadeBuffer: number
  volMult: number
  capVolMult: number
  volLen: number
  useTimeFlt: boolean
  tradeAsia: boolean
  tradeLondon: boolean
  tradeNYover: boolean
  tradeNYpm: boolean
  tradeLate: boolean
  useDowFlt: boolean
  /** Mon..Fri allowed. */
  days: [boolean, boolean, boolean, boolean, boolean]
  flatFriPM: boolean
}

export const FLYING_CPR_DEFAULTS: FlyingCprOptions = {
  tz: 'Asia/Kolkata',
  sessStart: 9 * 60 + 31,
  sessEnd: 9 * 60 + 59,
  reset: 9 * 60 + 30,
  useA: true,
  useB: true,
  useC: true,
  useD: true,
  wideBodyATR: 1.0,
  narrowRange: 0.6,
  fadeBuffer: 0.1,
  volMult: 1.2,
  capVolMult: 1.8,
  volLen: 20,
  useTimeFlt: true,
  tradeAsia: false,
  tradeLondon: true,
  tradeNYover: true,
  tradeNYpm: true,
  tradeLate: false,
  useDowFlt: true,
  days: [true, true, true, true, true],
  flatFriPM: true,
}

export type FcSetup = 'A' | 'B' | 'C' | 'D'

export interface FcSignal {
  index: number
  setup: FcSetup
  /** 1 = buy, -1 = sell. */
  side: 1 | -1
}

/** The original breakout arrows: close crossing SH / SL / F2.57 / F4.57. */
export interface FcArrow {
  index: number
  level: 'SH' | 'SL' | 'F2.57' | 'F4.57'
  side: 1 | -1
}

export interface FlyingCprResult {
  /** Per bar, NaN when not set. */
  sh: Float64Array
  sl: Float64Array
  /** up[k] / down[k] for FC_RATIOS[k]. */
  up: Float64Array[]
  down: Float64Array[]
  signals: FcSignal[]
  arrows: FcArrow[]
  atr: Float64Array
}

const MIN = 60_000
const DAY = 86_400_000

/** ta.atr: RMA of true range, seeded with the SMA of the first `len` values. */
export function atrRma(bars: FcBar[], len: number): Float64Array {
  const out = new Float64Array(bars.length).fill(Number.NaN)
  let sum = 0
  let prev = Number.NaN
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    const tr = i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))
    if (i < len) {
      sum += tr
      if (i === len - 1) prev = sum / len
    } else prev = (prev * (len - 1) + tr) / len
    out[i] = prev
  }
  return out
}

function sma(values: ArrayLike<number>, len: number): Float64Array {
  const out = new Float64Array(values.length).fill(Number.NaN)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= len) sum -= values[i - len]
    if (i >= len - 1) out[i] = sum / len
  }
  return out
}

/** Typical bar spacing: the smallest positive gap among the first bars. */
function barSpan(bars: FcBar[]): number {
  let best = Infinity
  for (let i = 1; i < Math.min(bars.length, 50); i++) {
    const d = bars[i].time - bars[i - 1].time
    if (d > 0 && d < best) best = d
  }
  return Number.isFinite(best) ? best : MIN
}

/** Does any minute of [m0, m0 + len) (local minutes, may pass 1440) fall in [a, b] (inclusive, may wrap)? */
function overlaps(m0: number, len: number, a: number, b: number): boolean {
  for (let k = 0; k < len; k++) {
    const m = (m0 + k) % 1440
    if (a <= b ? m >= a && m <= b : m >= a || m <= b) return true
  }
  return false
}

export function computeFlyingCpr(bars: FcBar[], opts: Partial<FlyingCprOptions> = {}): FlyingCprResult {
  const o: FlyingCprOptions = { ...FLYING_CPR_DEFAULTS, ...opts }
  const n = bars.length
  const sh = new Float64Array(n).fill(Number.NaN)
  const sl = new Float64Array(n).fill(Number.NaN)
  const up = FC_RATIOS.map(() => new Float64Array(n).fill(Number.NaN))
  const down = FC_RATIOS.map(() => new Float64Array(n).fill(Number.NaN))
  const atr = atrRma(bars, 14)
  const result: FlyingCprResult = { sh, sl, up, down, signals: [], arrows: [], atr }
  if (!n) return result
  const span = barSpan(bars)
  // daily or coarser bars have no intraday window to read
  if (span >= DAY) return result
  const barMin = Math.max(1, Math.round(span / MIN))
  const volAvg = sma(
    bars.map((b) => b.volume),
    Math.max(1, Math.round(o.volLen)),
  )

  let hi = Number.NaN
  let lo = Number.NaN
  for (let i = 0; i < n; i++) {
    const b = bars[i]
    const lc = localClock(o.tz, b.time)
    const m0 = Math.floor((lc % DAY) / MIN)
    if (overlaps(m0, barMin, o.reset, o.reset)) {
      hi = Number.NaN
      lo = Number.NaN
    }
    if (overlaps(m0, barMin, o.sessStart, o.sessEnd)) {
      hi = Number.isNaN(hi) ? b.high : Math.max(hi, b.high)
      lo = Number.isNaN(lo) ? b.low : Math.min(lo, b.low)
    }
    sh[i] = hi
    sl[i] = lo
    if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
      const r = hi - lo
      FC_RATIOS.forEach((k, j) => {
        up[j][i] = hi + r * k
        down[j][i] = lo - r * k
      })
    }
  }

  const cross = (i: number, lv: Float64Array, dir: 1 | -1): boolean => {
    if (i < 1) return false
    const a = lv[i]
    const p = lv[i - 1]
    if (Number.isNaN(a) || Number.isNaN(p)) return false
    return dir > 0 ? bars[i].close > a && bars[i - 1].close <= p : bars[i].close < a && bars[i - 1].close >= p
  }

  const F207 = 0
  const F257 = 1
  const F457 = 3
  const F1007 = 4
  for (let i = 0; i < n; i++) {
    const b = bars[i]
    // original breakout arrows
    if (cross(i, sh, 1)) result.arrows.push({ index: i, level: 'SH', side: 1 })
    if (cross(i, up[F257], 1)) result.arrows.push({ index: i, level: 'F2.57', side: 1 })
    if (cross(i, up[F457], 1)) result.arrows.push({ index: i, level: 'F4.57', side: 1 })
    if (cross(i, sl, -1)) result.arrows.push({ index: i, level: 'SL', side: -1 })
    if (cross(i, down[F257], -1)) result.arrows.push({ index: i, level: 'F2.57', side: -1 })
    if (cross(i, down[F457], -1)) result.arrows.push({ index: i, level: 'F4.57', side: -1 })

    // filters (UTC buckets, as the Pine script)
    const d = new Date(b.time)
    const h = d.getUTCHours()
    const dow = d.getUTCDay()
    const inAsia = h >= 22 || h < 6
    const inLondon = h >= 7 && h < 12
    const inNYover = h >= 12 && h < 16
    const inNYpm = h >= 16 && h < 21
    const inLate = h >= 21 && h < 22
    const allowedTime = !o.useTimeFlt || (o.tradeAsia && inAsia) || (o.tradeLondon && inLondon) || (o.tradeNYover && inNYover) || (o.tradeNYpm && inNYpm) || (o.tradeLate && inLate)
    const allowedDow = !o.useDowFlt || (dow >= 1 && dow <= 5 && o.days[dow - 1])
    const friPM = o.flatFriPM && dow === 5 && h >= 16
    if (!allowedTime || !allowedDow || friPM) continue

    const a = atr[i]
    const range = sh[i] - sl[i]
    const body = Math.abs(b.close - b.open)
    const buf = a * o.fadeBuffer
    const has = (v: number): boolean => !Number.isNaN(v)
    const push = (setup: FcSetup, side: 1 | -1): void => {
      result.signals.push({ index: i, setup, side })
    }

    // A — range breakout on a narrow-range (trend) day
    if (o.useA && has(range) && has(a) && a > 0 && range / a <= o.narrowRange && body >= a * o.wideBodyATR) {
      if (cross(i, sh, 1)) push('A', 1)
      if (cross(i, sl, -1)) push('A', -1)
    }

    // B — rejection of F2.07 / F2.57
    if (o.useB && has(buf)) {
      const sellAt = (v: number): boolean => has(v) && b.high >= v + buf && b.close < v && b.close < b.open
      const buyAt = (v: number): boolean => has(v) && b.low <= v - buf && b.close > v && b.close > b.open
      if (buyAt(down[F207][i]) || buyAt(down[F257][i])) push('B', 1)
      if (sellAt(up[F207][i]) || sellAt(up[F257][i])) push('B', -1)
    }

    // C — NY-reversal fade, 13:00–15:00 UTC
    if (o.useC && h >= 13 && h < 15 && has(volAvg[i]) && b.volume > volAvg[i] * o.volMult) {
      const sellAt = (v: number): boolean => has(v) && b.high >= v && b.close < v && b.close < b.open
      const buyAt = (v: number): boolean => has(v) && b.low <= v && b.close > v && b.close > b.open
      if (buyAt(down[F257][i]) || buyAt(down[F457][i])) push('C', 1)
      if (sellAt(up[F257][i]) || sellAt(up[F457][i])) push('C', -1)
    }

    // D — extreme capitulation past F4.57 / F10.07 on a volume spike
    if (o.useD && has(buf) && has(volAvg[i]) && b.volume > volAvg[i] * o.capVolMult) {
      const sellAt = (v: number): boolean => has(v) && b.high >= v + buf && b.close < v
      const buyAt = (v: number): boolean => has(v) && b.low <= v - buf && b.close > v
      if (buyAt(down[F457][i]) || buyAt(down[F1007][i])) push('D', 1)
      if (sellAt(up[F457][i]) || sellAt(up[F1007][i])) push('D', -1)
    }
  }
  return result
}

/** Pine's Mario mode: 19:xx in the session zone with the last close inside the range; strikes are F2.57 rounded to 200. */
export function marioState(bars: FcBar[], r: FlyingCprResult, tz: SessTz): { active: boolean; ce: number; pe: number } {
  const i = bars.length - 1
  if (i < 0) return { active: false, ce: Number.NaN, pe: Number.NaN }
  const hour = new Date(localClock(tz, bars[i].time)).getUTCHours()
  const c = bars[i].close
  const between = !Number.isNaN(r.sh[i]) && c >= r.sl[i] && c <= r.sh[i]
  const round200 = (x: number): number => Math.round(x / 200) * 200
  return { active: hour === 19 && between, ce: round200(r.up[1][i]), pe: round200(r.down[1][i]) }
}
