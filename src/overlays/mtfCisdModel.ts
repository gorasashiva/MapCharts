// "MTF CISD + MSS" — port of mtf.pine. Pure OHLCV math, no drawing.
//
// MSS : first close beyond the most recent confirmed swing high/low AGAINST the
//       current structure (a close beyond it WITH the structure is a BOS).
// CISD: close beyond the OPEN of the first candle in the latest run of
//       opposite-close candles, if that run delivered into a fresh N-bar extreme
//       and travelled at least minAtr × ATR(14). Direction alternates, except a
//       repeat is allowed after a deeper extreme (the prior one failed).
//
// The Pine script runs the same engine inside request.security() for up to 10
// timeframes. Here the higher timeframes are built by resampling the chart's
// own candles (the developing bucket included, like a realtime HTF bar), so
// only timeframes >= the chart's can be evaluated; lower ones are reported as
// unavailable.

import type { Candle } from '../core/types'

export interface MtfCisdOptions {
  autoTune: boolean
  pivLen: number
  cisdLook: number
  cisdAtr: number
  sweepLen: number
  sweepMax: number
}

export const MTF_CISD_DEFAULTS: MtfCisdOptions = {
  autoTune: true,
  pivLen: 3,
  cisdLook: 20,
  cisdAtr: 0.8,
  sweepLen: 5,
  sweepMax: 20,
}

/** Dashboard timeframes, in seconds. W and M use calendar buckets. */
export const TF_WEEK = 604_800
export const TF_MONTH = 2_592_000
export const MTF_CISD_TFS = [60, 180, 300, 900, 1800, 3600, 14_400, 86_400, TF_WEEK, TF_MONTH]

export interface CisdState {
  mDir: number
  mLvl: number
  mT: number
  mOt: number
  cDir: number
  cLvl: number
  cT: number
  cOt: number
}

export interface StructEvent {
  kind: 'MSS' | 'BOS' | 'CISD'
  dir: 1 | -1
  level: number
  originTime: number
  time: number
}

export interface SweepEvent {
  buySide: boolean
  level: number
  originTime: number
  time: number
}

export interface TfResult {
  tfSec: number
  /** False when the timeframe is below the chart's (no lower-TF data to resample). */
  available: boolean
  state: CisdState | null
}

export interface MtfCisdResult {
  chartSec: number
  chart: CisdState | null
  events: StructEvent[]
  sweeps: SweepEvent[]
  tfs: TfResult[]
}

/** f_params(): per-timeframe swing length, CISD lookback and CISD ATR filter. */
export function cisdParams(tfSec: number, o: MtfCisdOptions): { len: number; look: number; minAtr: number } {
  const s = tfSec
  if (!o.autoTune) return { len: o.pivLen, look: o.cisdLook, minAtr: o.cisdAtr }
  const len = s <= 300 ? 5 : s <= 900 ? 4 : s <= 14400 ? 3 : 2
  const look = s <= 60 ? 30 : s <= 300 ? 24 : s <= 900 ? 20 : s <= 3600 ? 16 : s <= 14400 ? 12 : 10
  const minAtr = s <= 300 ? 1.0 : s <= 900 ? 0.8 : s <= 3600 ? 0.7 : s <= 14400 ? 0.6 : 0.5
  return { len, look, minAtr }
}

// ---- Pine ta.* equivalents (NaN = na) ----

/** ta.pivothigh/low(src, len, len), reported on the confirming bar (center + len). */
function pivots(src: Float64Array, len: number, high: boolean): Float64Array {
  const n = src.length
  const out = new Float64Array(n).fill(NaN)
  for (let i = 2 * len; i < n; i++) {
    const c = i - len
    const v = src[c]
    let ok = true
    for (let k = c - len; k < c && ok; k++) ok = high ? v > src[k] : v < src[k]
    for (let k = c + 1; k <= i && ok; k++) ok = high ? v >= src[k] : v <= src[k]
    if (ok) out[i] = v
  }
  return out
}

/** ta.atr(len): RMA of true range, seeded with the SMA of the first `len` values. */
function atr(bars: Candle[], len: number): Float64Array {
  const n = bars.length
  const out = new Float64Array(n).fill(NaN)
  let sum = 0
  let prev = NaN
  for (let i = 0; i < n; i++) {
    const b = bars[i]
    const tr = i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))
    if (i < len) {
      sum += tr
      if (i === len - 1) prev = sum / len
    } else {
      prev = (prev * (len - 1) + tr) / len
    }
    out[i] = prev
  }
  return out
}

/** ta.highest / ta.lowest over `len` bars (na until `len` bars exist). */
function extreme(src: Float64Array, len: number, high: boolean): Float64Array {
  const n = src.length
  const out = new Float64Array(n).fill(NaN)
  for (let i = len - 1; i < n; i++) {
    let m = src[i]
    for (let k = i - len + 1; k < i; k++) m = high ? Math.max(m, src[k]) : Math.min(m, src[k])
    out[i] = m
  }
  return out
}

/** f_state() over a full series: every MSS/BOS/CISD event plus the final latest-event state. */
export function runCisdEngine(bars: Candle[], tfSec: number, o: MtfCisdOptions): { state: CisdState; events: StructEvent[] } {
  const { len, look, minAtr } = cisdParams(tfSec, o)
  const n = bars.length
  const hi = Float64Array.from(bars, (b) => b.high)
  const lo = Float64Array.from(bars, (b) => b.low)
  const ph = pivots(hi, len, true)
  const pl = pivots(lo, len, false)
  const atr14 = atr(bars, 14)
  const loN = extreme(lo, look, false)
  const hiN = extreme(hi, look, true)
  const events: StructEvent[] = []

  let swH = NaN, swHt = NaN, swHx = true
  let swL = NaN, swLt = NaN, swLx = true
  let trend = 0
  const st: CisdState = { mDir: 0, mLvl: NaN, mT: NaN, mOt: NaN, cDir: 0, cLvl: NaN, cT: NaN, cOt: NaN }

  let bearRunOpen = NaN, bearRunT = NaN, bearRunBar = NaN, bearRunExt = NaN, bearRunNew = false
  let bullRunOpen = NaN, bullRunT = NaN, bullRunBar = NaN, bullRunExt = NaN, bullRunNew = false
  let lastBullExt = NaN, lastBearExt = NaN

  for (let i = 0; i < n; i++) {
    const b = bars[i]
    // ---- structure ----
    if (!Number.isNaN(ph[i])) {
      swH = ph[i]
      swHt = bars[i - len].time
      swHx = false
    }
    if (!Number.isNaN(pl[i])) {
      swL = pl[i]
      swLt = bars[i - len].time
      swLx = false
    }
    if (!swHx && b.close > swH) {
      swHx = true
      const mss = trend !== 1
      events.push({ kind: mss ? 'MSS' : 'BOS', dir: 1, level: swH, originTime: swHt, time: b.time })
      if (mss) Object.assign(st, { mDir: 1, mLvl: swH, mT: b.time, mOt: swHt })
      trend = 1
    } else if (!swLx && b.close < swL) {
      swLx = true
      const mss = trend !== -1
      events.push({ kind: mss ? 'MSS' : 'BOS', dir: -1, level: swL, originTime: swLt, time: b.time })
      if (mss) Object.assign(st, { mDir: -1, mLvl: swL, mT: b.time, mOt: swLt })
      trend = -1
    }

    // ---- CISD ----
    if (!Number.isNaN(bearRunOpen)) {
      bearRunExt = Math.min(bearRunExt, b.low)
      bearRunNew = bearRunNew || b.low <= loN[i]
    }
    if (!Number.isNaN(bullRunOpen)) {
      bullRunExt = Math.max(bullRunExt, b.high)
      bullRunNew = bullRunNew || b.high >= hiN[i]
    }
    const a = atr14[i]
    const bullOk = !Number.isNaN(bearRunOpen) && bearRunNew && i - bearRunBar <= look && bearRunOpen - bearRunExt >= minAtr * a && (st.cDir !== 1 || bearRunExt < lastBullExt)
    const bearOk = !Number.isNaN(bullRunOpen) && bullRunNew && i - bullRunBar <= look && bullRunExt - bullRunOpen >= minAtr * a && (st.cDir !== -1 || bullRunExt > lastBearExt)
    if (bullOk && b.close > bearRunOpen) {
      Object.assign(st, { cDir: 1, cLvl: bearRunOpen, cT: b.time, cOt: bearRunT })
      events.push({ kind: 'CISD', dir: 1, level: bearRunOpen, originTime: bearRunT, time: b.time })
      lastBullExt = bearRunExt
      bearRunOpen = NaN
      bearRunNew = false
    } else if (bearOk && b.close < bullRunOpen) {
      Object.assign(st, { cDir: -1, cLvl: bullRunOpen, cT: b.time, cOt: bullRunT })
      events.push({ kind: 'CISD', dir: -1, level: bullRunOpen, originTime: bullRunT, time: b.time })
      lastBearExt = bullRunExt
      bullRunOpen = NaN
      bullRunNew = false
    }

    const p = i > 0 ? bars[i - 1] : undefined
    const prevBear = !!p && p.close < p.open
    const prevBull = !!p && p.close > p.open
    if (b.close < b.open && !prevBear) {
      // a still-live run hands its extreme/qualification to the newer run
      const live = !Number.isNaN(bearRunOpen) && i - bearRunBar <= look
      bearRunExt = live ? Math.min(bearRunExt, b.low) : b.low
      bearRunNew = (live && bearRunNew) || b.low <= loN[i]
      bearRunOpen = b.open
      bearRunT = b.time
      bearRunBar = i
    }
    if (b.close > b.open && !prevBull) {
      const live = !Number.isNaN(bullRunOpen) && i - bullRunBar <= look
      bullRunExt = live ? Math.max(bullRunExt, b.high) : b.high
      bullRunNew = (live && bullRunNew) || b.high >= hiN[i]
      bullRunOpen = b.open
      bullRunT = b.time
      bullRunBar = i
    }
  }
  return { state: st, events }
}

/** Liquidity pools from untaken swing highs/lows; wick through + close back inside = sweep. */
export function findSweeps(bars: Candle[], chartSec: number, o: MtfCisdOptions): SweepEvent[] {
  const sLen = o.autoTune ? (chartSec <= 300 ? 10 : chartSec <= 900 ? 8 : chartSec <= 3600 ? 6 : 5) : o.sweepLen
  const lph = pivots(Float64Array.from(bars, (b) => b.high), sLen, true)
  const lpl = pivots(Float64Array.from(bars, (b) => b.low), sLen, false)
  const liqH: { lv: number; t: number }[] = []
  const liqL: { lv: number; t: number }[] = []
  const out: SweepEvent[] = []
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    for (let k = liqH.length - 1; k >= 0; k--) {
      const { lv, t } = liqH[k]
      if (b.high > lv) {
        if (b.close < lv) out.push({ buySide: true, level: lv, originTime: t, time: b.time })
        liqH.splice(k, 1)
      }
    }
    for (let k = liqL.length - 1; k >= 0; k--) {
      const { lv, t } = liqL[k]
      if (b.low < lv) {
        if (b.close > lv) out.push({ buySide: false, level: lv, originTime: t, time: b.time })
        liqL.splice(k, 1)
      }
    }
    if (!Number.isNaN(lph[i])) {
      liqH.push({ lv: lph[i], t: bars[i - sLen].time })
      if (liqH.length > o.sweepMax) liqH.shift()
    }
    if (!Number.isNaN(lpl[i])) {
      liqL.push({ lv: lpl[i], t: bars[i - sLen].time })
      if (liqL.length > o.sweepMax) liqL.shift()
    }
  }
  return out
}

/** Bucket id of an epoch-ms time on a timeframe (UTC; weeks start Monday, months are calendar months). */
function bucketOf(time: number, tfSec: number): number {
  if (tfSec === TF_MONTH) {
    const d = new Date(time)
    return d.getUTCFullYear() * 12 + d.getUTCMonth()
  }
  if (tfSec === TF_WEEK) return Math.floor((Math.floor(time / 86_400_000) + 3) / 7)
  return Math.floor(time / (tfSec * 1000))
}

/** Resample chart candles onto a higher timeframe; the last bucket is the developing bar. */
export function resample(bars: Candle[], tfSec: number): Candle[] {
  const out: Candle[] = []
  let key = NaN
  for (const b of bars) {
    const k = bucketOf(b.time, tfSec)
    const cur = out[out.length - 1]
    if (k !== key || !cur) {
      key = k
      out.push({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })
    } else {
      cur.high = Math.max(cur.high, b.high)
      cur.low = Math.min(cur.low, b.low)
      cur.close = b.close
      cur.volume += b.volume
    }
  }
  return out
}

/** Median candle spacing in seconds — the chart timeframe. */
export function detectChartSec(bars: Candle[]): number {
  const n = bars.length
  if (n < 2) return 60
  const gaps: number[] = []
  for (let i = Math.max(1, n - 200); i < n; i++) gaps.push(bars[i].time - bars[i - 1].time)
  gaps.sort((a, b) => a - b)
  return Math.max(1, Math.round(gaps[gaps.length >> 1] / 1000))
}

/** Chart TF can come out slightly off its nominal value (gaps), so compare with ~10% slack. */
const sameTf = (a: number, b: number): boolean => Math.abs(a - b) <= b * 0.1
export const tfAtLeastChart = (tfSec: number, chartSec: number): boolean => tfSec >= chartSec || sameTf(tfSec, chartSec)
export const tfIsChart = sameTf

export function computeMtfCisd(bars: Candle[], tfList: number[], o: MtfCisdOptions, chartSecIn?: number): MtfCisdResult {
  const chartSec = chartSecIn ?? detectChartSec(bars)
  if (bars.length < 3) return { chartSec, chart: null, events: [], sweeps: [], tfs: tfList.map((tfSec) => ({ tfSec, available: false, state: null })) }
  const chart = runCisdEngine(bars, chartSec, o)
  const sweeps = findSweeps(bars, chartSec, o)
  const tfs = tfList.map((tfSec): TfResult => {
    if (!tfAtLeastChart(tfSec, chartSec)) return { tfSec, available: false, state: null }
    const series = sameTf(tfSec, chartSec) ? bars : resample(bars, tfSec)
    return { tfSec, available: true, state: runCisdEngine(series, tfSec, o).state }
  })
  return { chartSec, chart: chart.state, events: chart.events, sweeps, tfs }
}
