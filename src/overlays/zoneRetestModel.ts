/**
 * IV Zone Retest Strategy — pure model behind zoneRetest.ts.
 *
 * Built from the walk-forward study on gold (PAXG 2023–26, Delta XAUT 2026,
 * 5m / 15m): retest of a broken expected-move zone, graded by DeepCharts big
 * trades. Forward test 2025–26: about 62% wins, +0.27R per trade overall; the
 * A-grade subset (big trade in the trade's direction during the pullback, 15m)
 * about 69% wins, +0.47R.
 *
 * Zones ("modified" geometry): EM = previous session close × stdev of the last
 * `hvLookback` session-close returns × `scale`; levels at prev close ±
 * {0.382, 0.618, 1, 1.618, 2.618} × EM, each ± `half` × EM thick.
 *
 * Long rules (shorts mirror them):
 *  1. Price breaks up through a zone and reaches the next zone up.
 *  2. First pullback to the broken zone's top edge → buy limit there (or the
 *     candle's open if it gaps below it).
 *  3. Filters: fill inside 03:30–09:30 or 12:30–18:30 IST; skip days after a
 *     narrow-range day (yesterday's range in EM20 units in the bottom third of
 *     the last 60 sessions); skip days that opened more than 0.1 EM against
 *     the trade; skip when a CPR / PDH / PDL level sits 0.1–0.25 × scale EM from
 *     the zone (close to it but not on it); the swing high made before the
 *     pullback must be at least 1R away.
 *  4. Stop `stopBuffer` EM below the zone's bottom edge. Half off at 1R with
 *     the stop to breakeven; the rest at the swing high; flat at session end.
 *  5. Grade from DeepCharts big trades on 15m candles between the swing high
 *     and the fill: one in the trade's direction → A (full size); none → B
 *     (half size); only opposite ones → skipped.
 *
 * Fills are resolved on the chart's own candles, conservatively: a stop
 * touched on the fill candle counts, and targets count only from the next
 * candle on. The study resolved fills on 1m bars, so 5m / 15m results are a
 * little more conservative.
 */
import type { Candle } from '../core/types'
import { sessionIndex, SESSION_DAY_MS } from '../core/session'
import { buildSessions, type OHLCBar } from './ivWallsModel'
import { pivotLevels } from './cprModel'
import { computeDcBigTrades, DC_BIG_TRADES_DEFAULTS, type DcMark } from './dcBigTrades'

const MIN_MS = 60_000
const HOUR_MS = 60 * MIN_MS
const IST_OFFSET_MS = 330 * MIN_MS
const BT_TF_MS = 15 * MIN_MS

/** Delta Exchange India: taker 0.05%, maker 0.02%, +18% GST on the fee. */
const FEE_TAKER = 0.0005 * 1.18
const FEE_MAKER = 0.0002 * 1.18

export const ZR_LEVELS = {
  fib: [0.382, 0.618, 1.0, 1.618, 2.618],
  standard: [0.5, 1.0, 1.5, 2.0],
} as const
export type ZrLevelSet = keyof typeof ZR_LEVELS
export type ZrBigTradeMode = 'grade' | 'A only' | 'off'
export type ZrGrade = 'A' | 'B'

export interface ZoneRetestOptions {
  /** Sessions of close-to-close returns behind the EM. */
  hvLookback: number
  /** Multiplier on the EM (0.75 = the tested "modified" zones). */
  scale: number
  levels: ZrLevelSet
  /** Zone half-thickness, × EM. */
  half: number
  /** Stop distance beyond the zone's far edge, × EM. */
  stopBuffer: number
  /** Only fill inside 03:30–09:30 and 12:30–18:30 IST. */
  sessionWindows: boolean
  /** Skip days after a narrow-range day. */
  skipSmallRange: boolean
  /** Skip a side when the day opened more than 0.1 EM against it. */
  skipAgainstOpen: boolean
  /** Skip zones with a CPR / PDH / PDL level 0.1–0.25 × scale EM away. */
  cprFilter: boolean
  bigTrades: ZrBigTradeMode
  allowLongs: boolean
  allowShorts: boolean
}

export const ZONE_RETEST_DEFAULTS: ZoneRetestOptions = {
  hvLookback: 10,
  scale: 0.75,
  levels: 'fib',
  half: 0.1,
  stopBuffer: 0.15,
  sessionWindows: true,
  skipSmallRange: true,
  skipAgainstOpen: true,
  cprFilter: true,
  bigTrades: 'grade',
  allowLongs: true,
  allowShorts: true,
}

/** One session's zones (for drawing) and its day-level gates. */
export interface ZrSession {
  index: number
  start: number
  end: number
  prevClose: number
  em: number
  /** Zone centres, both sides, ascending. */
  levels: number[]
  halfWidth: number
  smallRangeDay: boolean
  /** Session open (for the "opened against" filter). */
  open: number
  /** Pivot, TC, BC, R1, S1, R2, S2, PDH, PDL from the previous session. */
  cpr: number[]
}

export interface ZrTrade {
  side: 'long' | 'short'
  grade: ZrGrade
  /** Which zone was retested, e.g. "+0.618x". */
  zone: string
  entryTime: number
  entryPrice: number
  stop: number
  tp1: number
  tp1Time: number | null
  /** Final target: the swing extreme before the pullback. */
  target: number
  exitTime: number | null
  exitPrice: number | null
  exitReason: 'TP' | 'SL' | 'BE' | 'Day end' | null
  /** Size-weighted average exit over both halves. */
  avgExitPrice: number | null
  barHigh: number
  barLow: number
  /** Before fees (spread not included). */
  grossR: number
  /** Net of Delta taker/maker fees. */
  r: number
  /** Chart label, e.g. "BUY A". */
  label: string
}

export interface ZrResult {
  sessions: ZrSession[]
  trades: ZrTrade[]
}

function sampleStd(xs: number[]): number | null {
  if (xs.length < 2) return null
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
}

function istMinutes(time: number): number {
  return Math.floor((((time + IST_OFFSET_MS) % SESSION_DAY_MS) + SESSION_DAY_MS) % SESSION_DAY_MS / MIN_MS)
}

/** 03:30–09:30 or 12:30–18:30 IST. */
export function inZrWindows(time: number): boolean {
  const m = istMinutes(time)
  return (m >= 210 && m < 570) || (m >= 750 && m < 1110)
}

/**
 * Zones and day gates per session, keyed by session index. Weekends are
 * dropped for closed-weekend symbols, so Monday's levels come from Friday.
 */
export function buildZrSessions(hourly: OHLCBar[], opts: ZoneRetestOptions, openHourUTC: number, closedWeekends: boolean): Map<number, ZrSession> {
  let days = buildSessions(hourly, openHourUTC)
  if (closedWeekends) {
    days = days.filter((d) => {
      const wd = new Date(d.start + 2 * HOUR_MS).getUTCDay()
      return wd !== 0 && wd !== 6
    })
  }
  const out = new Map<number, ZrSession>()
  const rets: number[] = [] // rets[k] = ln(close_k / close_{k-1}), k >= 1
  const pranges: number[] = []
  for (let i = 1; i < days.length; i++) {
    // Returns known before session i: up to the previous session's close.
    if (i >= 2) rets.push(Math.log(days[i - 1].close / days[i - 2].close))
    const prev = days[i - 1]
    const P = prev.close
    const sd = rets.length >= opts.hvLookback ? sampleStd(rets.slice(-opts.hvLookback)) : null
    const sd20 = rets.length >= 20 ? sampleStd(rets.slice(-20)) : null
    let small = false
    if (sd20) {
      const prange = (prev.high - prev.low) / (P * sd20)
      const hist = pranges.slice(-60)
      if (hist.length >= 20) {
        const sorted = [...hist].sort((a, b) => a - b)
        small = prange < sorted[Math.floor(sorted.length / 3)]
      }
      pranges.push(prange)
    }
    if (sd === null) continue
    const em = P * sd * opts.scale
    const lv = ZR_LEVELS[opts.levels]
    const pv = pivotLevels(prev)
    const idx = sessionIndex(days[i].start, openHourUTC)
    out.set(idx, {
      index: idx,
      start: days[i].start,
      end: days[i].end,
      prevClose: P,
      em,
      levels: [...lv.map((k) => P - k * em).reverse(), ...lv.map((k) => P + k * em)],
      halfWidth: opts.half * em,
      smallRangeDay: small,
      open: days[i].open,
      cpr: [pv.pivot, pv.tc, pv.bc, pv.r[0], pv.s[0], pv.r[1], pv.s[1], pv.prevHigh, pv.prevLow],
    })
  }
  return out
}

/** 15m candles from the chart's candles (only used for the big-trade grade). */
function to15m(candles: Candle[]): Candle[] {
  const out: Candle[] = []
  for (const c of candles) {
    const t = Math.floor(c.time / BT_TF_MS) * BT_TF_MS
    const last = out[out.length - 1]
    if (last && last.time === t) {
      last.high = Math.max(last.high, c.high)
      last.low = Math.min(last.low, c.low)
      last.close = c.close
      last.volume += c.volume
    } else out.push({ time: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })
  }
  return out
}

function rMultiples(side: 1 | -1, entry: number, legs: [number, number, boolean][], riskPx: number): { r: number; grossR: number } {
  let gross = 0
  let fees = 0
  for (const [px, w, maker] of legs) {
    gross += (px - entry) * side * w
    fees += w * (entry * FEE_MAKER + px * (maker ? FEE_MAKER : FEE_TAKER))
  }
  return { r: (gross - fees) / riskPx, grossR: gross / riskPx }
}

/**
 * Trades for the chart candles. `hourly` should cover ~90 sessions before the
 * chart's first candle (EM, the narrow-day rank and CPR). Sessions after the
 * last candle's are treated as still open, so their trades stay open.
 */
export function computeZoneRetest(candles: Candle[], hourly: OHLCBar[], opts: ZoneRetestOptions, openHourUTC: number, closedWeekends: boolean): ZrResult {
  const zr = buildZrSessions(hourly, opts, openHourUTC, closedWeekends)
  const sessions: ZrSession[] = []
  const trades: ZrTrade[] = []
  if (candles.length === 0) return { sessions, trades }

  // Big-trade marks on 15m candles; the chart's own candles are the lower timeframe for the pick.
  const marks: DcMark[] = opts.bigTrades === 'off' ? [] : computeDcBigTrades(to15m(candles), candles, DC_BIG_TRADES_DEFAULTS, BT_TF_MS, openHourUTC).marks
  const marksBetween = (from: number, to: number): DcMark[] => {
    const a = Math.floor(from / BT_TF_MS) * BT_TF_MS
    const b = Math.floor(to / BT_TF_MS) * BT_TF_MS
    return marks.filter((m) => m.time >= a && m.time <= b)
  }

  const bySession = new Map<number, Candle[]>()
  for (const c of candles) {
    const s = sessionIndex(c.time, openHourUTC)
    const arr = bySession.get(s)
    if (arr) arr.push(c)
    else bySession.set(s, [c])
  }
  const lastSession = sessionIndex(candles[candles.length - 1].time, openHourUTC)
  const lv = ZR_LEVELS[opts.levels]

  for (const [s, cs] of bySession) {
    const day = zr.get(s)
    if (!day) continue
    sessions.push(day)
    if (opts.skipSmallRange && day.smallRangeDay) continue
    const P = day.prevClose
    const E = day.em
    const n = cs.length
    const sessionOver = s < lastSession
    for (const side of [1, -1] as const) {
      if ((side === 1 && !opts.allowLongs) || (side === -1 && !opts.allowShorts)) continue
      // "Long space": EM units from the previous close, flipped for shorts so the logic reads as a long.
      const H = cs.map((c) => (side === 1 ? (c.high - P) / E : (P - c.low) / E))
      const L = cs.map((c) => (side === 1 ? (c.low - P) / E : (P - c.high) / E))
      const O = cs.map((c) => ((c.open - P) / E) * side)
      const C = cs.map((c) => ((c.close - P) / E) * side)
      if (opts.skipAgainstOpen && ((day.open - P) / E) * side < -0.1) continue
      const cprL = day.cpr.map((x) => ((x - P) / E) * side)
      const toPx = (x: number): number => P + side * x * E
      for (let li = 0; li < lv.length - 1; li++) {
        const Lz = lv[li]
        const a0 = H.findIndex((h) => h >= lv[li + 1] - opts.half) // reached the next zone
        if (a0 < 0) continue
        const entry = Lz + opts.half
        let k = -1
        for (let q = a0 + 1; q < n; q++) {
          if (L[q] <= entry) {
            k = q
            break
          }
        }
        if (k < 0) continue
        if (opts.sessionWindows && !inZrWindows(cs[k].time)) continue
        if (opts.cprFilter) {
          const dist = Math.min(...cprL.map((x) => Math.abs(x - Lz)))
          if (dist > 0.1 * opts.scale && dist <= 0.25 * opts.scale) continue
        }
        const stop = Lz - opts.half - opts.stopBuffer
        const e = Math.min(entry, O[k])
        const risk = e - stop
        if (risk <= 0.5 * (entry - stop)) continue // gapped through the zone onto the stop
        let hi = a0
        for (let q = a0; q <= k; q++) if (H[q] > H[hi]) hi = q
        const sw = H[hi]
        if (sw - e < risk) continue
        let grade: ZrGrade = 'B'
        if (opts.bigTrades !== 'off') {
          const ms = marksBetween(cs[hi].time, cs[k].time).map((m) => (m.bias === 'bull' ? 1 : -1))
          if (ms.includes(side)) grade = 'A'
          else if (ms.includes(-side as 1 | -1)) continue
          if (opts.bigTrades === 'A only' && grade !== 'A') continue
        }
        const trade: ZrTrade = {
          side: side === 1 ? 'long' : 'short',
          grade,
          zone: `${side === 1 ? '+' : '-'}${Lz}x`,
          entryTime: cs[k].time,
          entryPrice: toPx(e),
          stop: toPx(stop),
          tp1: toPx(e + risk),
          tp1Time: null,
          target: toPx(sw),
          exitTime: null,
          exitPrice: null,
          exitReason: null,
          avgExitPrice: null,
          barHigh: cs[k].high,
          barLow: cs[k].low,
          grossR: 0,
          r: 0,
          label: `${side === 1 ? 'BUY' : 'SELL'} ${grade}`,
        }
        const legs: [number, number, boolean][] = []
        let size = 1
        let st = stop
        const close = (q: number, x: number, why: ZrTrade['exitReason'], maker = false): void => {
          legs.push([toPx(x), size, maker])
          Object.assign(trade, { exitTime: cs[q].time, exitPrice: toPx(x), exitReason: why })
        }
        // Price comes down to the limit, so a stop touched on the fill candle counts.
        if (L[k] <= stop) close(k, stop, 'SL')
        else {
          for (let q = k + 1; q < n; q++) {
            if (L[q] <= st) {
              close(q, st, trade.tp1Time !== null ? 'BE' : 'SL')
              break
            }
            if (trade.tp1Time === null && H[q] >= e + risk) {
              legs.push([toPx(e + risk), 0.5, true])
              size = 0.5
              trade.tp1Time = cs[q].time
              st = e
            }
            if (H[q] >= sw) {
              close(q, sw, 'TP', true)
              break
            }
          }
          if (trade.exitTime === null && sessionOver) close(n - 1, C[n - 1], 'Day end')
        }
        const open = trade.exitTime === null
        const marked: [number, number, boolean][] = open ? [...legs, [cs[n - 1].close, size, false]] : legs
        Object.assign(trade, rMultiples(side, toPx(e), marked, risk * E))
        if (!open) trade.avgExitPrice = marked.reduce((acc, [px, w]) => acc + px * w, 0)
        trades.push(trade)
      }
    }
  }
  trades.sort((a, b) => a.entryTime - b.entryTime)
  sessions.sort((a, b) => a.start - b.start)
  return { sessions, trades }
}
