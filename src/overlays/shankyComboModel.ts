/**
 * Shankys Combo — port of "shanky combo.pine" (Pine v4 "Shankys trading 3-in-1").
 *
 *   1. CPR — daily TC / PP / BC (intraday charts only), R1–R3, S1–S3 and the
 *      previous day's high / low, for the last `cprDays` sessions.
 *   2. Auto Buy Sell — percent-reversal zigzag (RicardoSantos' multi-pattern
 *      zigzag): reversal line, legs, pivot labels with detected harmonic /
 *      tap / AB=CD / triangle / H&S patterns, triangle rate lines and a
 *      projection of the next leg.
 *   3. Rainbow — SSL-Hybrid-style baseline with Keltner channel (and bar
 *      colours), SX continuation dots, exit arrows, ATR bands and
 *      oversized-candle diamonds.
 *
 * Pure — no DOM / engine. Every output array is aligned 1:1 with the candles;
 * NaN plays Pine's `na`.
 */
import { isWeekendSession, periodBounds, pivotLevels } from './cprModel'

export interface ShankyBar {
  time: number
  open: number
  high: number
  low: number
  close: number
}

/** Moving-average types, in the Pine input order. */
export const SHANKY_MA = ['SMA', 'EMA', 'DEMA', 'TEMA', 'LSMA', 'WMA', 'MF', 'VAMA', 'TMA', 'HMA', 'JMA', 'Kijun v2', 'EDSMA', 'McGinley'] as const
export type ShankyMa = (typeof SHANKY_MA)[number]
/** Zigzag reversal methods: 0 = manual percent, else ATR(n) / open × multiplier. */
export const SHANKY_ZZ_ATR = [0, 5, 10, 20, 50, 100, 250] as const
export const SHANKY_ATR_SMOOTHING = ['RMA', 'SMA', 'EMA', 'WMA'] as const

export interface ShankyOptions {
  showCPR: boolean
  cprDays: number
  showAutoBS: boolean
  zzAtrLen: number // 0 = manual
  zzPercent: number // percent of the last pivot price (manual mode)
  zzAtrMult: number
  showRealPivots: boolean
  showZigzagLines: boolean
  showPivotPrice: boolean
  showTriangleRates: boolean
  showPatterns: boolean
  showProjections: boolean
  showProjectionBox: boolean
  showProjectionRates: boolean
  statsLength: number
  patternError: number // percent
  showRainbow: boolean
  showBaseline: boolean
  showSZ: boolean
  showATR: boolean
  atrLen: number
  atrMult: number
  atrSmoothing: (typeof SHANKY_ATR_SMOOTHING)[number]
  baselineType: ShankyMa
  baselineLen: number
  sxType: ShankyMa
  sxLen: number
  exitType: ShankyMa
  exitLen: number
  kijunDiv: number
  jurikPhase: number
  jurikPower: number
  vamaLookback: number
  mfBeta: number
  mfFeedback: boolean
  mfZ: number
  ssfLength: number
  ssfPoles: 2 | 3
  useTrueRange: boolean
  channelMult: number
  colorBars: boolean
  contAtr: number
}

export const SHANKY_DEFAULTS: ShankyOptions = {
  showCPR: true,
  cprDays: 7,
  showAutoBS: true,
  zzAtrLen: 0,
  zzPercent: 0.25,
  zzAtrMult: 1,
  showRealPivots: true,
  showZigzagLines: true,
  showPivotPrice: true,
  showTriangleRates: true,
  showPatterns: true,
  showProjections: true,
  showProjectionBox: true,
  showProjectionRates: false,
  statsLength: 10,
  patternError: 5,
  showRainbow: true,
  showBaseline: true,
  showSZ: false,
  showATR: true,
  atrLen: 14,
  atrMult: 1,
  atrSmoothing: 'WMA',
  baselineType: 'HMA',
  baselineLen: 60,
  sxType: 'JMA',
  sxLen: 5,
  exitType: 'HMA',
  exitLen: 15,
  kijunDiv: 1,
  jurikPhase: 3,
  jurikPower: 1,
  vamaLookback: 10,
  mfBeta: 0.8,
  mfFeedback: false,
  mfZ: 0.5,
  ssfLength: 20,
  ssfPoles: 2,
  useTrueRange: true,
  channelMult: 0.2,
  colorBars: true,
  contAtr: 0.9,
}

// ---------------------------------------------------------------------------
// Pine ta.* helpers (NaN = na)
// ---------------------------------------------------------------------------
type S = number[]
const nz = (v: number, d = 0): number => (isNaN(v) ? d : v)

export function sma(src: S, len: number): S {
  const out = new Array<number>(src.length).fill(NaN)
  let sum = 0
  let n = 0
  for (let i = 0; i < src.length; i++) {
    if (isNaN(src[i])) {
      sum = 0
      n = 0
      continue
    }
    sum += src[i]
    n++
    if (n > len) sum -= src[i - len]
    if (n >= len) out[i] = sum / len
  }
  return out
}

/** Pine ema: seeded with the SMA of the first `len` values. */
export function ema(src: S, len: number): S {
  const out = new Array<number>(src.length).fill(NaN)
  const a = 2 / (len + 1)
  const seed = sma(src, len)
  let prev = NaN
  for (let i = 0; i < src.length; i++) {
    if (isNaN(prev)) prev = seed[i]
    else if (!isNaN(src[i])) prev = a * src[i] + (1 - a) * prev
    out[i] = prev
  }
  return out
}

/** Pine rma (Wilder): seeded with the SMA. */
export function rma(src: S, len: number): S {
  const out = new Array<number>(src.length).fill(NaN)
  const seed = sma(src, len)
  let prev = NaN
  for (let i = 0; i < src.length; i++) {
    if (isNaN(prev)) prev = seed[i]
    else if (!isNaN(src[i])) prev = (src[i] + (len - 1) * prev) / len
    out[i] = prev
  }
  return out
}

export function wma(src: S, len: number): S {
  const out = new Array<number>(src.length).fill(NaN)
  const den = (len * (len + 1)) / 2
  for (let i = len - 1; i < src.length; i++) {
    let num = 0
    let ok = true
    for (let k = 0; k < len; k++) {
      const v = src[i - k]
      if (isNaN(v)) {
        ok = false
        break
      }
      num += v * (len - k)
    }
    if (ok) out[i] = num / den
  }
  return out
}

function highest(src: S, len: number): S {
  return src.map((_, i) => {
    if (i < len - 1) return NaN
    let m = -Infinity
    for (let k = i - len + 1; k <= i; k++) m = Math.max(m, src[k])
    return m
  })
}
function lowest(src: S, len: number): S {
  return src.map((_, i) => {
    if (i < len - 1) return NaN
    let m = Infinity
    for (let k = i - len + 1; k <= i; k++) m = Math.min(m, src[k])
    return m
  })
}

/** Pine linreg(src, len, 0): least-squares line value at the latest bar. */
function linreg(src: S, len: number): S {
  return src.map((_, i) => {
    if (i < len - 1) return NaN
    let sx = 0
    let sy = 0
    let sxy = 0
    let sxx = 0
    for (let k = 0; k < len; k++) {
      const y = src[i - len + 1 + k]
      sx += k
      sy += y
      sxy += k * y
      sxx += k * k
    }
    const slope = (len * sxy - sx * sy) / (len * sxx - sx * sx)
    const icpt = (sy - slope * sx) / len
    return icpt + slope * (len - 1)
  })
}

function stdev(src: S, len: number): S {
  return src.map((_, i) => {
    if (i < len - 1) return NaN
    let s = 0
    for (let k = i - len + 1; k <= i; k++) s += src[k]
    const m = s / len
    let v = 0
    for (let k = i - len + 1; k <= i; k++) v += (src[k] - m) ** 2
    return Math.sqrt(v / len)
  })
}

/** Pine tr(handleNa): true range; the first bar is high − low when handleNa, else na. */
export function trueRange(b: ShankyBar[], handleNa: boolean): S {
  return b.map((x, i) =>
    i === 0 ? (handleNa ? x.high - x.low : NaN) : Math.max(x.high - x.low, Math.abs(x.high - b[i - 1].close), Math.abs(x.low - b[i - 1].close)),
  )
}

function maOf(type: ShankyMa, src: S, len: number, bars: ShankyBar[], o: ShankyOptions): S {
  const n = src.length
  const L = Math.max(1, Math.round(len))
  switch (type) {
    case 'SMA':
      return sma(src, L)
    case 'EMA':
      return ema(src, L)
    case 'DEMA': {
      const e = ema(src, L)
      const ee = ema(e, L)
      return e.map((v, i) => 2 * v - ee[i])
    }
    case 'TEMA': {
      const e = ema(src, L)
      const ee = ema(e, L)
      const eee = ema(ee, L)
      return e.map((v, i) => 3 * (v - ee[i]) + eee[i])
    }
    case 'LSMA':
      return linreg(src, L)
    case 'WMA':
      return wma(src, L)
    case 'TMA':
      return sma(sma(src, Math.ceil(L / 2)), Math.floor(L / 2) + 1)
    case 'HMA': {
      const half = wma(src, Math.max(1, Math.floor(L / 2)))
      const full = wma(src, L)
      return wma(
        half.map((v, i) => 2 * v - full[i]),
        Math.max(1, Math.round(Math.sqrt(L))),
      )
    }
    case 'VAMA': {
      const mid = ema(src, L)
      const dev = src.map((v, i) => v - mid[i])
      const up = highest(dev, o.vamaLookback)
      const dn = lowest(dev, o.vamaLookback)
      return mid.map((v, i) => v + (up[i] + dn[i]) / 2)
    }
    case 'JMA': {
      const pr = o.jurikPhase < -100 ? 0.5 : o.jurikPhase > 100 ? 2.5 : o.jurikPhase / 100 + 1.5
      const beta = (0.45 * (L - 1)) / (0.45 * (L - 1) + 2)
      const alpha = Math.pow(beta, o.jurikPower)
      const out = new Array<number>(n).fill(NaN)
      let e0 = 0
      let e1 = 0
      let e2 = 0
      let jma = 0
      for (let i = 0; i < n; i++) {
        const v = src[i]
        if (isNaN(v)) continue
        e0 = (1 - alpha) * v + alpha * e0
        e1 = (v - e0) * (1 - beta) + beta * e1
        e2 = (e0 + pr * e1 - jma) * Math.pow(1 - alpha, 2) + Math.pow(alpha, 2) * e2
        jma = e2 + jma
        out[i] = jma
      }
      return out
    }
    case 'Kijun v2': {
      const lows = bars.map((b) => b.low)
      const highs = bars.map((b) => b.high)
      const k1 = lowest(lows, L)
      const k2 = highest(highs, L)
      const d = Math.max(1, Math.floor(L / Math.max(1, o.kijunDiv)))
      const c1 = lowest(lows, d)
      const c2 = highest(highs, d)
      return k1.map((_, i) => ((k1[i] + k2[i]) / 2 + (c1[i] + c2[i]) / 2) / 2)
    }
    case 'McGinley': {
      const e = ema(src, L)
      const out = new Array<number>(n).fill(NaN)
      let mg = NaN
      for (let i = 0; i < n; i++) {
        mg = isNaN(mg) ? e[i] : mg + (src[i] - mg) / (L * Math.pow(src[i] / mg, 4))
        out[i] = mg
      }
      return out
    }
    case 'MF': {
      const alpha = 2 / (L + 1)
      const out = new Array<number>(n).fill(NaN)
      let ts = NaN
      let b = NaN
      let c = NaN
      let os = 0
      for (let i = 0; i < n; i++) {
        const s = src[i]
        const a = o.mfFeedback ? o.mfZ * s + (1 - o.mfZ) * nz(ts, s) : s
        const eb = alpha * a + (1 - alpha) * nz(b, a)
        const ec = alpha * a + (1 - alpha) * nz(c, a)
        b = a > eb ? a : eb
        c = a < ec ? a : ec
        os = a === b ? 1 : a === c ? 0 : os
        const upper = o.mfBeta * b + (1 - o.mfBeta) * c
        const lower = o.mfBeta * c + (1 - o.mfBeta) * b
        ts = os * upper + (1 - os) * lower
        out[i] = ts
      }
      return out
    }
    case 'EDSMA': {
      const zeros = src.map((v, i) => v - nz(src[i - 2]))
      const avgZ = zeros.map((v, i) => (i === 0 ? NaN : (v + zeros[i - 1]) / 2))
      const ssf = new Array<number>(n).fill(0)
      if (o.ssfPoles === 2) {
        const arg = (Math.SQRT2 * Math.PI) / o.ssfLength
        const a1 = Math.exp(-arg)
        const c2 = 2 * a1 * Math.cos(arg)
        const c3 = -(a1 * a1)
        const c1 = 1 - c2 - c3
        for (let i = 0; i < n; i++) ssf[i] = c1 * nz(avgZ[i]) + c2 * nz(ssf[i - 1]) + c3 * nz(ssf[i - 2])
      } else {
        const arg = Math.PI / o.ssfLength
        const a1 = Math.exp(-arg)
        const b1 = 2 * a1 * Math.cos(1.738 * arg)
        const c1 = a1 * a1
        const k2 = b1 + c1
        const k3 = -(c1 + b1 * c1)
        const k4 = c1 * c1
        const k1 = 1 - k2 - k3 - k4
        for (let i = 0; i < n; i++) ssf[i] = k1 * nz(avgZ[i]) + k2 * nz(ssf[i - 1]) + k3 * nz(ssf[i - 2]) + k4 * nz(ssf[i - 3])
      }
      const sd = stdev(ssf, L)
      const out = new Array<number>(n).fill(NaN)
      let ed = NaN
      for (let i = 0; i < n; i++) {
        const scaled = sd[i] ? ssf[i] / sd[i] : 0
        const alpha = (5 * Math.abs(scaled)) / L
        ed = alpha * src[i] + (1 - alpha) * nz(ed)
        out[i] = ed
      }
      return out
    }
  }
}

// ---------------------------------------------------------------------------
// 1. CPR
// ---------------------------------------------------------------------------
export interface ShankyCprDay {
  start: number
  end: number
  tc: number
  pp: number
  bc: number
  r: [number, number, number]
  s: [number, number, number]
  ph: number
  pl: number
}

/**
 * Levels for each session from the previous session's high / low / close,
 * built from the chart's own candles. A session is drawn only when the one
 * before it is fully loaded, and only the last `days` sessions (Pine:
 * `timenow - time < one_day * daily_cpr`, measured from the latest bar).
 */
export function shankyCpr(bars: ShankyBar[], days: number, openHourUTC: number, skipWeekends: boolean): ShankyCprDay[] {
  if (bars.length < 2 || days <= 0) return []
  type P = { start: number; end: number; high: number; low: number; close: number; first: number }
  const periods: P[] = []
  for (const b of bars) {
    if (skipWeekends && isWeekendSession(b.time, openHourUTC)) continue
    const cur = periods[periods.length - 1]
    if (!cur || b.time >= cur.end) {
      const [start, end] = periodBounds(b.time, 'day', openHourUTC)
      periods.push({ start, end, high: b.high, low: b.low, close: b.close, first: b.time })
    } else {
      cur.high = Math.max(cur.high, b.high)
      cur.low = Math.min(cur.low, b.low)
      cur.close = b.close
    }
  }
  const barMs = bars[1].time - bars[0].time
  const now = bars[bars.length - 1].time
  const out: ShankyCprDay[] = []
  for (let i = 1; i < periods.length; i++) {
    const prev = periods[i - 1]
    const p = periods[i]
    if (now - p.start >= days * 86_400_000) continue
    if (prev.first - prev.start > barMs) continue // the previous session starts before the loaded data
    if (p.start - prev.end > 4 * 86_400_000) continue // data gap
    const lv = pivotLevels(prev)
    out.push({ start: p.start, end: p.end, tc: lv.tc, pp: lv.pivot, bc: lv.bc, r: [lv.r[0], lv.r[1], lv.r[2]], s: [lv.s[0], lv.s[1], lv.s[2]], ph: prev.high, pl: prev.low })
  }
  return out
}

// ---------------------------------------------------------------------------
// 2. Auto Buy Sell — zigzag + patterns + projection
// ---------------------------------------------------------------------------
export interface ShankyPivot {
  time: number
  price: number
  /** The pivot is a swing high (the leg into it went up). */
  high: boolean
  /** Price, plus the detected pattern names (high: price first; low: price last). */
  text: string
}

export interface ShankyLeg {
  t1: number
  p1: number
  t2: number
  p2: number
  up: boolean
}

export interface ShankyRateLine {
  x1: number
  y1: number
  x2: number
  y2: number
  up: boolean
  text: string
}

export interface ShankyProjection {
  /** Dashed midline from the last pivot to the average target, extended right. */
  mid: [number, number, number, number]
  /** Vertical arrow at the target time: price deviation band. */
  priceDev: [number, number, number, number]
  /** Horizontal arrow at the target price: time deviation band. */
  timeDev: [number, number, number, number]
  /** Box from the 0.618 to the 1.618 extension. */
  box: [number, number, number, number] | null
  labels: { time: number; price: number; text: string; up: boolean }[]
}

export interface ShankyZigzag {
  /** Reversal threshold line (Pine plots it one bar to the right). */
  reverse: number[]
  pivots: ShankyPivot[]
  legs: ShankyLeg[]
  rateLines: ShankyRateLine[]
  projection: ShankyProjection | null
}

const rate = (c: number, b: number, a: number): number => (a - b) / (b - c)
const timeRate = (c: number, b: number, a: number): number => -(a - b) / (b - c)
const inRange = (v: number, lo: number, hi: number): boolean => v <= hi && v >= lo

export function detectShankyPatterns(P: Record<string, number>, m: number): string[] {
  const { gfa, gda, gba, gfe, fed, feb, fcb, edc, eda, eba, dcb, cba } = P
  const out: string[] = []
  const vGfa = fed >= -1 && feb >= -1 && cba <= -1 && eda <= -1
  const vGda = fed <= -1 && gfe >= -1 && cba <= -1 && dcb >= -1
  const vGba = feb <= -1 && gfe >= -1 && cba <= -1 && dcb <= -1
  const vEba = cba <= -1 && dcb <= -1
  const vEda = cba <= -1 && dcb >= -1
  const vFcb = fed >= -1 && edc <= -1
  const vFeb = edc >= -1 && dcb <= -1
  const harmonic = (x: number): boolean => {
    for (let i = 1; i <= 12; i++) {
      const c = -Math.pow(1.618, -5 + i)
      if (inRange(x, c - m, c + m)) return true
    }
    return false
  }
  const tap = (x: number): boolean => inRange(x, -1 - m, -1 + m)
  const abcd = (c: number, d: number): boolean => inRange(c, -1.618 - m, -1.27 + m) && inRange(d, -0.786 - m, -0.618 + m)
  type Spec = [number, number, number, number, number, number, number, number]
  const four = (edc_: number, dcb_: number, cba_: number, eda_: number, s: Spec): boolean =>
    inRange(edc_, s[0] - m, s[1] + m) && inRange(dcb_, s[2] - m, s[3] + m) && inRange(cba_, s[4] - m, s[5] + m) && inRange(eda_, s[6] - m, s[7] + m)
  // [edc lo, hi, dcb lo, hi, cba lo, hi, eda lo, hi] — as in the Pine is*() functions.
  const SPECS: [string, Spec][] = [
    ['Bat', [-0.5, -0.382, -0.886, -0.382, -2.618, -1.618, -0.886, -0.886]],
    ['Butterfly', [-0.786, -0.786, -0.886, -0.382, -2.618, -1.618, -1.618, -1.27]],
    ['Gartley', [-0.618, -0.618, -0.886, -0.382, -2.618, -1.13, -0.786, -0.786]],
    ['Crab', [-0.886, -0.886, -0.886, -0.382, -3.618, -2.0, -1.618, -1.618]],
    ['Shark', [-0.886, -0.886, -1.618, -1.13, -2.24, -1.27, -1.13, -0.886]],
    ['5o', [-1.618, -1.13, -2.24, -1.618, -0.5, -0.5, -0.236, 0.236]],
    ['Wolf', [-1.618, -1.27, -5.0, 0, -1.618, -1.27, -5.0, 0]],
    ['Contracting Triangle', [-0.886, -0.236, -0.886, -0.236, -0.886, -0.236, -0.886, -0.236]],
    ['Expanding Triangle', [-2.618, -1.125, -2.618, -1.125, -2.618, -1.125, -2.618, -1.125]],
  ]
  if (harmonic(gfa) && vGfa) out.push('Harmonic Triangle(GFA)')
  if (harmonic(gda) && vGda) out.push('Harmonic Triangle(GDA)')
  if (harmonic(gba) && vGba) out.push('Harmonic Triangle(GBA)')
  if (harmonic(eba) && vEba) out.push('Harmonic Triangle(EBA)')
  if (harmonic(eda) && vEda) out.push('Harmonic Triangle(EDA)')
  if (harmonic(cba)) out.push('Harmonic Triangle(CBA)')
  if (tap(cba)) out.push('Double Tap(CBA)')
  if (tap(eba) && vEba) out.push('Double Tap(EBA)')
  if (tap(eda) && vEda) out.push('Double Tap(EDA)')
  if (tap(edc) && tap(cba)) out.push('Triple Tap(EDC, CBA)')
  if (tap(gfe) && tap(edc) && tap(cba)) out.push('Quadruple Tap(GFE, EDC, CBA)')
  if (abcd(cba, dcb)) out.push('AB=CD(CBA, DCB)')
  if (abcd(cba, fcb) && vFcb) out.push('AB=CD(CBA, FCB)')
  if (abcd(eba, feb) && vFeb) out.push('AB=CD(EBA, FEB)')
  if (abcd(eda, fed) && vEda) out.push('AB=CD(EDA, FED)')
  for (const [name, s] of SPECS) {
    if (four(edc, dcb, cba, eda, s)) out.push(`${name}(EDC, DCB, CBA, EDA)`)
    if (four(gfe, feb, eba, gfa, s) && vEba) out.push(`${name}(GFE, FEB, EBA, GFA)`)
    if (four(gfe, fed, eda, gfa, s) && vEda) out.push(`${name}(GFE, FED, EDA, GFA)`)
  }
  const hns =
    inRange(fed, -0.618 - m, -0.09 + m) &&
    inRange(feb, -0.886 - m, -0.09 + m) &&
    inRange(edc, -9.999 - m, -1.0 + m) &&
    inRange(eda, -1.618 - m, -0.09 + m) &&
    inRange(dcb, -1.25 - m, -0.75 + m) &&
    inRange(cba, -0.886 - m, -0.09 + m)
  if (hns) out.push('Head and Shoulders(FED, FEB, DCB, EDC, EDA, CBA)')
  return out
}

/** Pine f_mode_process_stats: EW average / +dev / −dev of a series that changes only at pivots. */
function processStats(data: number[], weight: number): { avg: number; pos: number; neg: number } {
  let avg = NaN
  let pos = 0
  let neg = 0
  let prevData = NaN
  let prevPosR = NaN
  let prevNegR = NaN
  for (let i = 0; i < data.length; i++) {
    const d = data[i]
    if (i === 0) avg = d
    else {
      const ch = d - prevData
      if (!isNaN(ch) && ch !== 0) avg = weight * d + (1 - weight) * nz(avg, prevData)
    }
    const posR = Math.max(0, d - avg)
    const negR = Math.min(0, d - avg)
    const valid = !isNaN(d - avg)
    if (i >= 1 && valid) {
      const cp = posR - prevPosR
      if (!isNaN(cp) && cp !== 0) pos = weight * posR + (1 - weight) * pos
      const cn = negR - prevNegR
      if (!isNaN(cn) && cn !== 0) neg = weight * negR + (1 - weight) * neg
    }
    prevData = d
    prevPosR = valid ? posR : NaN
    prevNegR = valid ? negR : NaN
  }
  return { avg, pos, neg }
}

const fmtPrice = (v: number): string => String(Number(v.toFixed(5)))

export function shankyZigzag(bars: ShankyBar[], o: ShankyOptions): ShankyZigzag {
  const n = bars.length
  const reverse = new Array<number>(n).fill(NaN)
  const res: ShankyZigzag = { reverse, pivots: [], legs: [], rateLines: [], projection: null }
  if (n < 2) return res

  // Reversal threshold as a fraction of the last pivot: manual %, or ATR(n) / open × multiplier.
  const atr = o.zzAtrLen > 0 ? rma(trueRange(bars, false), o.zzAtrLen) : null
  const percentAt = (i: number): number => (atr ? (atr[i] / bars[i].open) * o.zzAtrMult : o.zzPercent / 100)

  // f_zz — one pass, in the Pine statement order (an up-leg can end and the down-leg start on the same bar).
  let up: boolean | null = null
  let htrack = NaN
  let ltrack = NaN
  let pivot = NaN
  let realTime = NaN
  let htime = NaN
  let ltime = NaN
  let rev = 0
  const pivotSeries = new Array<number>(n).fill(NaN)
  const realTimes = new Array<number>(n).fill(NaN)
  for (let i = 0; i < n; i++) {
    const b = bars[i]
    if (i >= 1) {
      if (up === null) up = true
      const range = nz(pivotSeries[i - 1]) * percentAt(i)
      const p = bars[i - 1]
      if (up) {
        ltrack = NaN
        ltime = b.time
        if (isNaN(htrack)) {
          if (b.high > p.high) {
            htrack = b.high
            htime = b.time
          } else {
            htrack = p.high
            htime = p.time
          }
        } else if (b.high > htrack) {
          htrack = b.high
          htime = b.time
        }
        rev = htrack - range
        if (b.close <= rev) {
          pivot = htrack
          realTime = htime
          up = false
        }
      }
      if (!up) {
        htrack = NaN
        htime = NaN
        if (isNaN(ltrack)) {
          if (b.low < p.low) {
            ltrack = b.low
            ltime = b.time
          } else {
            ltrack = p.low
            ltime = p.time
          }
        } else if (b.low < ltrack) {
          ltrack = b.low
          ltime = b.time
        }
        rev = ltrack + range
        if (b.close >= rev) {
          pivot = ltrack
          realTime = ltime
          up = true
        }
      }
    }
    pivotSeries[i] = pivot
    realTimes[i] = realTime
    reverse[i] = rev
  }

  // Pivots a..g, shifted on each new zig (Pine: change(price_a) != 0, false while price_a was na).
  let T = [NaN, NaN, NaN, NaN, NaN, NaN, NaN]
  let Pp = [NaN, NaN, NaN, NaN, NaN, NaN, NaN]
  const abPrice = new Array<number>(n).fill(NaN)
  const abTime = new Array<number>(n).fill(NaN)
  let lastR: Record<string, number> | null = null
  let lastRT: Record<string, number> | null = null
  for (let i = 0; i < n; i++) {
    const pa = pivotSeries[i]
    const prev = i > 0 ? pivotSeries[i - 1] : NaN
    if (!isNaN(pa) && !isNaN(prev) && pa !== prev) {
      const t = o.showRealPivots ? realTimes[i] : bars[i].time
      T = [t, T[0], T[1], T[2], T[3], T[4], T[5]]
      Pp = [pa, Pp[0], Pp[1], Pp[2], Pp[3], Pp[4], Pp[5]]
      const [a, b, c, d, e, f, g] = Pp
      const [ta, tb, tc, td, te, tf, tg] = T
      if (!isNaN(b)) res.legs.push({ t1: tb, p1: b, t2: ta, p2: a, up: a > b })
      lastR = {
        gfa: rate(g, f, a), gda: rate(g, d, a), gfe: rate(g, f, e), gba: rate(g, b, a),
        fed: rate(f, e, d), feb: rate(f, e, b), fcb: rate(f, c, b),
        edc: rate(e, d, c), eda: rate(e, d, a), eba: rate(e, b, a),
        dcb: rate(d, c, b), cba: rate(c, b, a),
      }
      lastRT = {
        gfa: timeRate(tg, tf, ta), gda: timeRate(tg, td, ta), gba: timeRate(tg, tb, ta),
        feb: timeRate(tf, te, tb), eda: timeRate(te, td, ta), eba: timeRate(te, tb, ta),
        dcb: timeRate(td, tc, tb), cba: timeRate(tc, tb, ta),
      }
      if (o.showPivotPrice || o.showPatterns) {
        const high = a > b
        const list = (o.showPatterns ? detectShankyPatterns(lastR, o.patternError / 100) : []).map((x) => `• ${x} •`)
        const price = o.showPivotPrice ? fmtPrice(a) : ''
        const lines = high ? [price, ...list] : [...list, price]
        res.pivots.push({ time: ta, price: a, high, text: lines.filter((x) => x !== '').join('\n') })
      }
    }
    abPrice[i] = Math.abs(Pp[0] - Pp[1])
    abTime[i] = T[0] - T[1]
  }

  // Triangle rate lines for the latest pivot (Pine redraws each one, so only the latest set shows).
  if (o.showTriangleRates && lastR && lastRT) {
    const R = lastR
    const RT = lastRT
    const [a, b, c, d, e, f, g] = Pp
    const [ta, tb, tc, td, te, tf, tg] = T
    const line = (pr: number, tr: number, x1: number, y1: number, x2: number, y2: number, upLabel: boolean): void => {
      if ([pr, tr, x1, y1, x2, y2].some((v) => !isFinite(v))) return
      res.rateLines.push({ x1, y1, x2, y2, up: upLabel, text: `Price: ${pr.toFixed(3)}\nTime: ${tr.toFixed(3)}` })
    }
    if (R.cba < R.edc && R.edc < R.gfe) {
      line(R.gfa, RT.gfa, ta, a, tg, g, a < f)
      line(R.gda, RT.gda, ta, a, tg, g, a < d)
      line(R.gba, RT.gba, ta, a, tg, g, a < b)
    }
    if (R.cba < R.edc) {
      line(R.eda, RT.eda, ta, a, te, e, a < d)
      line(R.eba, RT.eba, ta, a, te, e, a < b)
    }
    line(R.cba, RT.cba, ta, a, tc, c, a < b)
    line(R.dcb, RT.dcb, tb, b, td, d, b < c)
    if (R.dcb < R.fed) line(R.feb, RT.feb, tb, b, tf, f, b < e)
  }

  // Projection of the next leg from the EW stats of past leg sizes and durations.
  const [a, b] = Pp
  const ta = T[0]
  if (o.showProjections && !isNaN(a) && !isNaN(b)) {
    const w = 2 / (o.statsLength + 1)
    const ps = processStats(abPrice, w)
    const ts = processStats(abTime, w)
    if (!isNaN(ps.avg) && !isNaN(ts.avg)) {
      const sgn = a > b ? -1 : 1 // after a swing high the next leg goes down
      const avgP = a + sgn * ps.avg
      const upperDev = a + sgn * (ps.avg + ps.neg)
      const lowerDev = a + sgn * (ps.avg + ps.pos)
      const p0618 = a + sgn * (ps.avg + ps.neg) * 0.618
      const p1618 = a + sgn * (ps.avg + ps.pos) * 1.618
      const avgT = Math.trunc(ta + ts.avg)
      const tUp = Math.trunc(avgT + ts.pos)
      const tLo = Math.trunc(avgT + ts.neg)
      const t0618 = Math.trunc(ta + (ts.avg + ts.neg) * 0.618)
      const t1618 = Math.trunc(ta + (ts.avg + ts.pos) * 1.618)
      const isUp = sgn > 0
      res.projection = {
        mid: [ta, a, avgT, avgP],
        priceDev: [avgT, lowerDev, avgT, upperDev],
        timeDev: [tLo, avgP, tUp, avgP],
        box: o.showProjectionBox ? [t0618, p0618, t1618, p1618] : null,
        labels: o.showProjectionRates
          ? [
              { time: t1618, price: p1618, text: `Target 1.618 @ ${fmtPrice(p1618)}`, up: !isUp },
              { time: t0618, price: p0618, text: `Target 0.618 @ ${fmtPrice(p0618)}`, up: isUp },
            ]
          : [],
      }
    }
  }
  return res
}

// ---------------------------------------------------------------------------
// 3. Rainbow
// ---------------------------------------------------------------------------
export interface ShankyRainbow {
  baseline: number[]
  upperK: number[]
  lowerK: number[]
  /** Bar / baseline colour: 1 above the channel (green), −1 below (orange), 0 inside (grey). */
  zone: (1 | -1 | 0)[]
  sz: number[]
  szAbove: (boolean | null)[]
  sx: number[]
  /** SX dot colour: 1 buy continuation (green), −1 sell continuation (purple), 0 none (white). */
  sxState: (1 | -1 | 0)[]
  upperBand: number[]
  lowerBand: number[]
  diamond: boolean[]
  /** Exit arrows: 1 close crosses above the exit line, −1 below. */
  arrow: (1 | -1 | 0)[]
}

/** SSL line: the high MA while price last closed below the low MA, else the low MA. */
function sslLine(close: number[], hi: number[], lo: number[]): number[] {
  let hlv = NaN
  return close.map((c, i) => {
    hlv = c > hi[i] ? 1 : c < lo[i] ? -1 : hlv
    return hlv < 0 ? hi[i] : lo[i]
  })
}

export function shankyRainbow(bars: ShankyBar[], o: ShankyOptions): ShankyRainbow {
  const close = bars.map((b) => b.close)
  const high = bars.map((b) => b.high)
  const low = bars.map((b) => b.low)
  const tr1 = trueRange(bars, true)
  const atr =
    o.atrSmoothing === 'RMA' ? rma(tr1, o.atrLen) : o.atrSmoothing === 'SMA' ? sma(tr1, o.atrLen) : o.atrSmoothing === 'EMA' ? ema(tr1, o.atrLen) : wma(tr1, o.atrLen)
  const upperBand = close.map((c, i) => c + atr[i] * o.atrMult)
  const lowerBand = close.map((c, i) => c - atr[i] * o.atrMult)

  const ma = (type: ShankyMa, src: number[], len: number): number[] => maOf(type, src, len, bars, o)
  const emaHigh = ma(o.baselineType, high, o.baselineLen)
  const emaLow = ma(o.baselineType, low, o.baselineLen)
  const maHigh = ma(o.sxType, high, o.sxLen)
  const maLow = ma(o.sxType, low, o.sxLen)
  const exitHigh = ma(o.exitType, high, o.exitLen)
  const exitLow = ma(o.exitType, low, o.exitLen)
  const baseline = ma(o.baselineType, close, o.baselineLen)
  const rng = o.useTrueRange ? trueRange(bars, false) : bars.map((b) => b.high - b.low)
  const rangeMa = ema(rng, Math.max(1, Math.round(o.baselineLen)))
  const upperK = baseline.map((v, i) => v + rangeMa[i] * o.channelMult)
  const lowerK = baseline.map((v, i) => v - rangeMa[i] * o.channelMult)

  const sz = sslLine(close, emaHigh, emaLow)
  const sx = sslLine(close, maHigh, maLow)
  const exit = sslLine(close, exitHigh, exitLow)

  const n = bars.length
  const zone: (1 | -1 | 0)[] = new Array(n)
  const szAbove: (boolean | null)[] = new Array(n)
  const sxState: (1 | -1 | 0)[] = new Array(n)
  const diamond: boolean[] = new Array(n)
  const arrow: (1 | -1 | 0)[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const c = close[i]
    zone[i] = c > upperK[i] ? 1 : c < lowerK[i] ? -1 : 0
    szAbove[i] = c > sz[i] ? true : c < sz[i] ? false : null
    const buyIn = c - atr[i] * o.contAtr < sx[i]
    const sellIn = c + atr[i] * o.contAtr > sx[i]
    const sellCont = c < baseline[i] && c < sx[i]
    const buyCont = c > baseline[i] && c > sx[i]
    sxState[i] = buyIn && buyCont ? 1 : sellIn && sellCont ? -1 : 0
    const inBand = upperBand[i] > baseline[i] && lowerBand[i] < baseline[i]
    diamond[i] = Math.abs(c - bars[i].open) > atr[i] && inBand
    const pc = i > 0 ? close[i - 1] : NaN
    const pe = i > 0 ? exit[i - 1] : NaN
    arrow[i] = c > exit[i] && pc <= pe ? 1 : exit[i] > c && pe <= pc ? -1 : 0
  }
  return { baseline, upperK, lowerK, zone, sz, szAbove, sx, sxState, upperBand, lowerBand, diamond, arrow }
}

export interface ShankyResult {
  cpr: ShankyCprDay[]
  intraday: boolean
  zigzag: ShankyZigzag | null
  rainbow: ShankyRainbow | null
}

export function computeShankyCombo(bars: ShankyBar[], o: ShankyOptions, openHourUTC: number, skipWeekends: boolean): ShankyResult {
  const barMs = bars.length > 1 ? bars[1].time - bars[0].time : 0
  return {
    cpr: o.showCPR ? shankyCpr(bars, o.cprDays, openHourUTC, skipWeekends) : [],
    intraday: barMs > 0 && barMs < 86_400_000,
    zigzag: o.showAutoBS ? shankyZigzag(bars, o) : null,
    rainbow: o.showRainbow ? shankyRainbow(bars, o) : null,
  }
}
