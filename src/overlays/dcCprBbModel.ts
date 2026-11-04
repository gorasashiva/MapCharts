/**
 * Donchian + CPR (D/W/M) + Bollinger Bands — ported from the "Donchian + CPR
 * (D/W/M) + Bollinger Bands" Pine script (v6, shorttitle "DC+CPR+BB").
 *
 *   Donchian: highest high / lowest low of `dcLen` bars and their mean.
 *   Bollinger: SMA / EMA / WMA / VWMA basis ± mult × population stdev.
 *   CPR: pivot / TC / BC / R1 / S1 / R2 / S2 from the PREVIOUS completed
 *   day, week and month (Pine's request.security(..., [high[1], low[1],
 *   close[1]], lookahead_on) — no repainting).
 *   Day open, SMA 21 / 34, and the one-candle BUY / SELL rule: a candle that
 *   opens below every reference line and closes above all of them (and above
 *   the day open) is a BUY; the mirror is a SELL.
 *
 * Periods are built from the chart's own candles on the symbol's trading
 * day (core/session.ts), so a weekly / monthly CPR appears once the loaded
 * history covers a whole previous week / month. The first period in the
 * data is partial, so the CPR after it is left out rather than drawn wrong.
 * Rolling windows use running sums / monotonic deques: O(n) per compute.
 */
import type { Candle } from '../core/types'
import { computePeriodKeys } from './periodKeys'
import { sourceOf, type VeaSource } from './vwapEmaAngleModel'

export type BbMa = 'sma' | 'ema' | 'wma' | 'vwma'

export interface DcCprBbOptions {
  dcLen: number
  bbLen: number
  bbSource: VeaSource
  bbMult: number
  bbMa: BbMa
  sma1Len: number
  sma2Len: number
  /** Which reference lines a signal candle must cross (Pine: all four). */
  useDcMid: boolean
  useBbBasis: boolean
  useSma1: boolean
  useSma2: boolean
  /** Pine: BUY needs close > day open, SELL close < day open. */
  dayOpenFilter: boolean
}

export const DC_CPR_BB_DEFAULTS: DcCprBbOptions = {
  dcLen: 20,
  bbLen: 20,
  bbSource: 'close',
  bbMult: 2,
  bbMa: 'sma',
  sma1Len: 21,
  sma2Len: 34,
  useDcMid: true,
  useBbBasis: true,
  useSma1: true,
  useSma2: true,
  dayOpenFilter: true,
}

export interface CprLevels {
  p: number
  tc: number
  bc: number
  r1: number
  s1: number
  r2: number
  s2: number
}

export function cprFrom(h: number, l: number, c: number): CprLevels {
  const p = (h + l + c) / 3
  const bc0 = (h + l) / 2
  const tc0 = 2 * p - bc0
  return { p, tc: Math.max(tc0, bc0), bc: Math.min(tc0, bc0), r1: 2 * p - l, s1: 2 * p - h, r2: p + (h - l), s2: p - (h - l) }
}

/** A run of bars that share one period's CPR (from the previous period's H/L/C). */
export interface CprSpan {
  from: number // first bar index
  to: number // last bar index (inclusive)
  lv: CprLevels
}

export interface DcCprBbResult {
  dcUp: Float64Array
  dcLo: Float64Array
  dcMid: Float64Array
  bbBasis: Float64Array
  bbUp: Float64Array
  bbLo: Float64Array
  sma1: Float64Array
  sma2: Float64Array
  dayOpen: Float64Array
  /** First bar of each trading day (the day-open line breaks there). */
  newDay: Uint8Array
  cprD: CprSpan[]
  cprW: CprSpan[]
  cprM: CprSpan[]
  /** 1 = BUY, -1 = SELL, 0 = none. */
  signal: Int8Array
}

function rollingMax(src: ArrayLike<number>, len: number, max: boolean): Float64Array {
  const n = src.length
  const out = new Float64Array(n).fill(NaN)
  const dq = new Int32Array(n)
  let head = 0
  let tail = 0
  for (let i = 0; i < n; i++) {
    const v = src[i]
    while (tail > head && (max ? src[dq[tail - 1]] <= v : src[dq[tail - 1]] >= v)) tail--
    dq[tail++] = i
    if (dq[head] <= i - len) head++
    if (i >= len - 1) out[i] = src[dq[head]]
  }
  return out
}

function sma(src: ArrayLike<number>, len: number): Float64Array {
  const n = src.length
  const out = new Float64Array(n).fill(NaN)
  let s = 0
  for (let i = 0; i < n; i++) {
    s += src[i]
    if (i >= len) s -= src[i - len]
    if (i >= len - 1) out[i] = s / len
  }
  return out
}

function ema(src: ArrayLike<number>, len: number): Float64Array {
  const n = src.length
  const out = new Float64Array(n).fill(NaN)
  const a = 2 / (len + 1)
  let seed = 0
  for (let i = 0; i < n; i++) {
    if (i < len - 1) seed += src[i]
    else if (i === len - 1) out[i] = (seed + src[i]) / len
    else out[i] = a * src[i] + (1 - a) * out[i - 1]
  }
  return out
}

/** Linearly weighted MA (newest weight = len), O(n) via running sums. */
function wma(src: ArrayLike<number>, len: number): Float64Array {
  const n = src.length
  const out = new Float64Array(n).fill(NaN)
  const denom = (len * (len + 1)) / 2
  let sum = 0 // plain window sum
  let wsum = 0 // weighted window sum
  for (let i = 0; i < n; i++) {
    if (i < len) {
      wsum += (i + 1) * src[i]
      sum += src[i]
      if (i === len - 1) out[i] = wsum / denom
      continue
    }
    wsum = wsum - sum + len * src[i]
    sum = sum - src[i - len] + src[i]
    out[i] = wsum / denom
  }
  return out
}

export function computeDcCprBb(candles: Candle[], symbol: string, o: DcCprBbOptions): DcCprBbResult {
  const n = candles.length
  const hi = new Float64Array(n)
  const lo = new Float64Array(n)
  const cl = new Float64Array(n)
  const src = new Float64Array(n)
  const vol = new Float64Array(n)
  const times = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const c = candles[i]
    hi[i] = c.high
    lo[i] = c.low
    cl[i] = c.close
    src[i] = sourceOf(c, o.bbSource)
    vol[i] = c.volume > 0 ? c.volume : 0
    times[i] = c.time
  }
  const dcLen = Math.max(1, Math.round(o.dcLen))
  const dcUp = rollingMax(hi, dcLen, true)
  const dcLo = rollingMax(lo, dcLen, false)
  const dcMid = new Float64Array(n)
  for (let i = 0; i < n; i++) dcMid[i] = (dcUp[i] + dcLo[i]) / 2

  // ---- Bollinger ----
  const bbLen = Math.max(1, Math.round(o.bbLen))
  let basis: Float64Array
  if (o.bbMa === 'ema') basis = ema(src, bbLen)
  else if (o.bbMa === 'wma') basis = wma(src, bbLen)
  else if (o.bbMa === 'vwma') {
    const pv = new Float64Array(n)
    for (let i = 0; i < n; i++) pv[i] = src[i] * vol[i]
    const a = sma(pv, bbLen)
    const b = sma(vol, bbLen)
    basis = new Float64Array(n)
    for (let i = 0; i < n; i++) basis[i] = b[i] > 0 ? a[i] / b[i] : NaN
  } else basis = sma(src, bbLen)
  // population stdev of src over bbLen (Pine ta.stdev, biased) — running sums, shifted for precision
  const bbUp = new Float64Array(n).fill(NaN)
  const bbLo = new Float64Array(n).fill(NaN)
  const k = n ? src[0] : 0
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < n; i++) {
    const x = src[i] - k
    s1 += x
    s2 += x * x
    if (i >= bbLen) {
      const y = src[i - bbLen] - k
      s1 -= y
      s2 -= y * y
    }
    if (i >= bbLen - 1 && Number.isFinite(basis[i])) {
      const mean = s1 / bbLen
      const dev = o.bbMult * Math.sqrt(Math.max(0, s2 / bbLen - mean * mean))
      bbUp[i] = basis[i] + dev
      bbLo[i] = basis[i] - dev
    }
  }

  const sma1 = sma(cl, Math.max(1, Math.round(o.sma1Len)))
  const sma2 = sma(cl, Math.max(1, Math.round(o.sma2Len)))

  // ---- periods: day open + D/W/M CPR ----
  const keys = computePeriodKeys(times, symbol)
  const dayOpen = new Float64Array(n).fill(NaN)
  const newDay = new Uint8Array(n)
  const spans = (key: Int32Array, skipWeekend: boolean): CprSpan[] => {
    const out: CprSpan[] = []
    let curKey = NaN
    let h = -Infinity
    let l = Infinity
    let c = NaN
    let periods = 0
    let span: CprSpan | null = null
    for (let i = 0; i < n; i++) {
      const wk = skipWeekend && keys.weekend[i] === 1
      if (!wk && key[i] !== curKey) {
        // the finished period's H/L/C feed the new one's CPR (the first, partial, period never does)
        const prev = periods >= 2 && Number.isFinite(c) ? cprFrom(h, l, c) : null
        periods++
        curKey = key[i]
        h = -Infinity
        l = Infinity
        c = NaN
        span = prev ? { from: i, to: i, lv: prev } : null
        if (span) out.push(span)
      }
      if (!wk) {
        if (hi[i] > h) h = hi[i]
        if (lo[i] < l) l = lo[i]
        c = cl[i]
      }
      if (span) span.to = i
    }
    return out
  }
  const cprD = spans(keys.day, true)
  const cprW = spans(keys.week, false)
  const cprM = spans(keys.month, false)

  let curOpen = NaN
  for (let i = 0; i < n; i++) {
    if (i === 0 || keys.day[i] !== keys.day[i - 1]) {
      newDay[i] = 1
      curOpen = candles[i].open
    }
    dayOpen[i] = curOpen
  }

  // ---- signals ----
  const signal = new Int8Array(n)
  const lines = [o.useDcMid ? dcMid : null, o.useBbBasis ? basis : null, o.useSma1 ? sma1 : null, o.useSma2 ? sma2 : null].filter((a): a is Float64Array => a !== null)
  if (lines.length) {
    for (let i = 0; i < n; i++) {
      let top = -Infinity
      let bot = Infinity
      let ok = true
      for (const a of lines) {
        const v = a[i]
        if (!Number.isFinite(v)) {
          ok = false
          break
        }
        if (v > top) top = v
        if (v < bot) bot = v
      }
      if (!ok) continue
      const c = candles[i]
      if (c.open < bot && c.close > top && (!o.dayOpenFilter || c.close > dayOpen[i])) signal[i] = 1
      else if (c.open > top && c.close < bot && (!o.dayOpenFilter || c.close < dayOpen[i])) signal[i] = -1
    }
  }

  return { dcUp, dcLo, dcMid, bbBasis: basis, bbUp, bbLo, sma1, sma2, dayOpen, newDay, cprD, cprW, cprM, signal }
}
