// Bullseye Order Flow (BullsEyeOF.pine, MPL 2.0, © goofyfarmer), ported. Pure maths; drawing is in
// examples/basic/bullseyeOf.ts.
//
// Two engines, as in the script:
//   • Footprint — per-price bought / sold volume of each bar from our own Volume Footprint (exact taker
//     trades from the live tape and the tape recorder; src/overlays/footprintBarStore.ts). Gives exact
//     delta, diagonal stacked imbalances (buys at a row vs sells one row lower, at ≥ the imbalance
//     multiplier, N rows in a row), boundary imbalances in the bar's bottom / top quarter, and the
//     trapped-trader test on the bar's own POC row. Stacked imbalances project as shelves.
//   • Geometric proxy — where a bar has no footprint: buy share = (close − low) / range.
// On top of either:
//   • Effort vs. reward candle states (Section 7): demand absorption (gold), supply absorption (purple),
//     initiative bull / bear drives, muted dead volume, standard bull / bear — tuned by the 1–10 effort dial.
//   • Session profiles (Section 11): Cash 09:30–16:00 New York and Overnight (the rest of the day) — every
//     day, the script's 24/7 "Day/Night 7-Day" mode, which fits Delta's 24/7 gold, BTC and ETH. 60 rows per
//     session; footprint rows go to their own price, other bars are spread with the script's Gaussian kernel
//     (σ = range / 3, buy centred between low and close, sell between close and high); VPOC; value area by
//     cumulative mass (VAL at 15 %, VAH at 85 %); Dalton shape D / P / b / B with the LVN between peaks.
//   • Key levels (Section 10): overnight high / low, half-back, overnight POC, prior cash high / low and POC,
//     a confluent POC when the prior cash and overnight POCs sit close together, and the latest virgin POC.

import type { Candle } from '../core/types'
import type { FpBarFlow } from './footprintBarStore'
import { nyOffsetMinutes } from './nyClock'

export type CandleState = 'gold' | 'purple' | 'muted' | 'bullDrive' | 'bearDrive' | 'bull' | 'bear'
export type ProfileShape = 'D' | 'P' | 'b' | 'B'
export type SessionKind = 'cash' | 'on'

export interface BullseyeProfile {
  kind: SessionKind
  start: number
  /** Time of the session's last bar. */
  end: number
  lo: number
  hi: number
  step: number
  /** Buy and sell volume per row (row r spans lo + r·step … lo + (r+1)·step); length = rows + 1. */
  buy: number[]
  sell: number[]
  poc: number
  vah: number
  val: number
  shape: ProfileShape
  /** Low-volume node between the two peaks of a B shape. */
  lvn: number | null
  /** Session buy − sell volume as a share of its volume (−1 … 1). */
  deltaShare: number
  complete: boolean
}

export interface BullseyeLevels {
  onHigh: number | null
  onLow: number | null
  halfBack: number | null
  onPoc: number | null
  pdHigh: number | null
  pdLow: number | null
  priorCashPoc: number | null
  priorCashVah: number | null
  priorCashVal: number | null
  /** Prior cash POC and overnight POC agree within the cluster tolerance: their midpoint. */
  confluentPoc: number | null
  /** The latest completed session's POC, while price has not traded back to it. */
  virginPoc: { price: number; from: number } | null
}

/** A stacked imbalance projected forward until price closes through it. */
export interface ImbalanceShelf {
  side: 'bull' | 'bear'
  from: number
  lo: number
  hi: number
  /** Time of the bar that closed through it (null = still active). */
  end: number | null
}

export interface BullseyeResult {
  states: CandleState[]
  profiles: BullseyeProfile[]
  levels: BullseyeLevels
  shelves: ImbalanceShelf[]
  /** Bars that used footprint rows (the rest used the geometric proxy). */
  footprintBars: number
}

export interface BullseyeOptions {
  /** Institutional effort sensitivity, 1 (loose) … 10 (strict); the script's default is 5. */
  effort: number
}

export const BULLSEYE_DEFAULTS: BullseyeOptions = { effort: 5 }

const ROWS = 60
const BELL_DIV = 3
const MIN = 60_000
const CASH_START = 9 * 60 + 30
const CASH_END = 16 * 60
const MAX_SHELVES = 20

/** Minute of the day in New York time. */
export function nyMinuteOfDay(ms: number): number {
  const m = Math.floor(ms / MIN) + nyOffsetMinutes(ms)
  return ((m % 1440) + 1440) % 1440
}

export const isCashMinute = (ms: number): boolean => {
  const m = nyMinuteOfDay(ms)
  return m >= CASH_START && m < CASH_END
}

const sma = (xs: number[], i: number, n: number): number => {
  if (i < n - 1) return Number.NaN
  let s = 0
  for (let k = i - n + 1; k <= i; k++) s += xs[k]
  return s / n
}

/** Wilder ATR(14), as ta.atr: NaN until 14 bars. */
function atr14(c: Candle[]): number[] {
  const out = new Array<number>(c.length).fill(Number.NaN)
  let prev = Number.NaN
  let sum = 0
  for (let i = 0; i < c.length; i++) {
    const tr = i === 0 ? c[i].high - c[i].low : Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close))
    if (i < 14) {
      sum += tr
      if (i === 13) prev = sum / 14
    } else prev = (prev * 13 + tr) / 14
    if (i >= 13) out[i] = prev
  }
  return out
}

const geoShare = (c: Candle): number => {
  const range = Math.max(c.high - c.low, 1e-9)
  return (c.close - c.low) / range
}

/** The script's footprint calibration from the effort dial: imbalance multiplier and stack depth. */
export function imbalanceCalibration(effort: number): { mult: number; depth: number } {
  const e = Math.min(10, Math.max(1, Math.round(effort)))
  return { mult: 2.2 + ((e - 1) / 9) * 1.6, depth: e <= 3 ? 2 : e <= 8 ? 3 : 4 }
}

export interface FootprintScan {
  /** First stacked buy imbalance [low, high] (price), if any. */
  bullStack: [number, number] | null
  bearStack: [number, number] | null
  /** Sell imbalance in the bar's bottom quarter / buy imbalance in its top quarter. */
  bottomSellImb: boolean
  topBuyImb: boolean
  /** Price of the bar's highest-volume row. */
  poc: number | null
}

/**
 * The script's diagonal row scan over one bar's footprint (rows ascending, zero rows ignored):
 * buy imbalance when the buys at row i+1 ≥ mult × the sells at row i; sell imbalance when the sells at
 * row i ≥ mult × the buys at row i+1; `depth` of them in a row make a stack.
 */
export function footprintScan(rows: Map<number, [number, number]>, rowSize: number, mult: number, depth: number, minVol = 0): FootprintScan {
  const none: FootprintScan = { bullStack: null, bearStack: null, bottomSellImb: false, topBuyImb: false, poc: null }
  if (rows.size === 0 || !(rowSize > 0)) return none
  const keys = [...rows.keys()]
  const r0 = Math.min(...keys)
  const r1 = Math.max(...keys)
  const arr: [number, number][] = []
  for (let r = r0; r <= r1; r++) arr.push(rows.get(r) ?? [0, 0])
  let pocK = 0
  for (let k = 1; k < arr.length; k++) if (arr[k][0] + arr[k][1] > arr[pocK][0] + arr[pocK][1]) pocK = k
  const out: FootprintScan = { ...none, poc: (r0 + pocK + 0.5) * rowSize }
  const n = arr.length
  if (n < 2) return out
  const bottomCut = Math.max(1, Math.floor(n * 0.25))
  const topCut = Math.min(n - 2, Math.floor(n * 0.75))
  let bullRun = 0
  let bearRun = 0
  let bullLo = 0
  let bearLo = 0
  for (let i = 0; i <= n - 2; i++) {
    const sCur = arr[i][1]
    const bNext = arr[i + 1][0]
    const buyImb = sCur > 0 && bNext > 0 && bNext >= sCur * mult && bNext >= minVol
    const sellImb = bNext > 0 && sCur > 0 && sCur >= bNext * mult && sCur >= minVol
    if (i < bottomCut && sellImb) out.bottomSellImb = true
    if (i >= topCut && buyImb) out.topBuyImb = true
    if (buyImb) {
      bullRun++
      if (bullRun === 1) bullLo = (r0 + i + 1) * rowSize
      if (bullRun === depth && !out.bullStack) out.bullStack = [bullLo, (r0 + i + 2) * rowSize]
    } else bullRun = 0
    if (sellImb) {
      bearRun++
      if (bearRun === 1) bearLo = (r0 + i) * rowSize
      if (bearRun === depth && !out.bearStack) out.bearStack = [bearLo, (r0 + i + 1) * rowSize]
    } else bearRun = 0
  }
  return out
}

const usableRows = (f: FpBarFlow | undefined): f is FpBarFlow & { rows: Map<number, [number, number]>; rowSize: number } =>
  !!f && !!f.rows && f.rows.size >= 2 && !!f.rowSize && f.rowSize > 0

interface ClassifyOut {
  states: CandleState[]
  stacks: { i: number; side: 'bull' | 'bear'; lo: number; hi: number }[]
  footprintBars: number
}

function classify(c: Candle[], tfMs: number, o: BullseyeOptions, now: number, flow?: Map<number, FpBarFlow>): ClassifyOut {
  const s = (Math.min(10, Math.max(1, o.effort)) - 1) / 9
  const reqRvolAbsorb = 1.1 + s * 0.9
  const reqDeltaRatio = 0.15 + s * 0.25
  const effBodyDrive = 0.55 + s * 0.25
  const aggWickMult = 0.85 + s * 0.3
  const aggRvolMult = 0.85 + s * 0.45
  const { mult, depth } = imbalanceCalibration(o.effort)
  const tfSec = tfMs / 1000
  const baseWick = tfSec <= 60 ? 0.38 : tfSec <= 900 ? 0.35 : tfSec <= 14400 ? 0.3 : 0.25
  const reqWick = Math.min(0.55, baseWick * aggWickMult)
  const hourly = Math.round(tfSec) === 3600

  const fps = c.map((b) => {
    const f = flow?.get(b.time)
    return usableRows(f) ? f : undefined
  })
  const vol = c.map((b) => b.volume)
  const delta = c.map((b, i) => (fps[i] ? fps[i]!.delta : b.volume * (2 * geoShare(b) - 1)))
  const absDelta = delta.map(Math.abs)
  const atr = atr14(c)
  const todSum = new Array<number>(24).fill(0)
  const todCount = new Array<number>(24).fill(0)
  const states: CandleState[] = []
  const stacks: ClassifyOut['stacks'] = []
  let footprintBars = 0

  for (let i = 0; i < c.length; i++) {
    const b = c[i]
    const fp = fps[i]
    const range = Math.max(b.high - b.low, 1e-9)
    const ma20 = sma(vol, i, 20)
    const rvol = ma20 > 0 ? b.volume / ma20 : 1
    // time-of-day relative volume on 1-hour charts (the hour's own average, once it has 5 samples)
    let effRvol = rvol
    if (hourly) {
      const hr = Math.floor(nyMinuteOfDay(b.time) / 60)
      if (todCount[hr] >= 5 && todSum[hr] > 0) effRvol = b.volume / (todSum[hr] / todCount[hr])
      todSum[hr] += b.volume
      todCount[hr]++
    }
    const live = i === c.length - 1 && b.time + tfMs > now
    const fraction = live ? Math.max(0.1, Math.min(1, Math.max(1000, now - b.time) / Math.max(1000, tfMs))) : 1
    const liveRvol = effRvol / fraction
    const safeAtr = atr[i] > 0 ? atr[i] : range
    const lowerWickPct = (Math.min(b.open, b.close) - b.low) / range
    const upperWickPct = (b.high - Math.max(b.open, b.close)) / range
    const bodyPct = Math.abs(b.close - b.open) / range
    const d = delta[i]
    const barVol = fp ? fp.vol : b.volume
    const deltaPct = barVol > 0 ? (d / barVol) * 100 : 0
    const smaAbs = sma(absDelta, i, 20)
    const safeSma = smaAbs > 0 ? smaAbs : 1
    const minute = nyMinuteOfDay(b.time)
    const churn = minute >= CASH_START && minute < CASH_START + 5 // 09:30–09:35 opening blackout

    // footprint scan (exact rows only)
    let scan: FootprintScan | null = null
    let trappedLongs = false
    let trappedShorts = false
    if (fp) {
      footprintBars++
      scan = footprintScan(fp.rows, fp.rowSize, mult, depth, 0)
      if (scan.poc !== null) {
        const loc = (scan.poc - b.low) / range
        trappedLongs = loc >= 0.8 && b.close < scan.poc && (d < 0 || liveRvol >= 1.1)
        trappedShorts = loc <= 0.2 && b.close > scan.poc && (d > 0 || liveRvol >= 1.1)
      }
      if (scan.bullStack) stacks.push({ i, side: 'bull', lo: scan.bullStack[0], hi: scan.bullStack[1] })
      if (scan.bearStack) stacks.push({ i, side: 'bear', lo: scan.bearStack[0], hi: scan.bearStack[1] })
    }
    const bottomSell = !!scan?.bottomSellImb
    const topBuy = !!scan?.topBuyImb

    const effort = liveRvol >= reqRvolAbsorb || absDelta[i] / safeSma >= 1.25
    const bullWick = lowerWickPct >= reqWick && b.close >= b.low + 0.5 * range
    const bearWick = upperWickPct >= reqWick && b.close <= b.high - 0.5 * range
    const stdBull = !churn && bullWick && effort && (d < 0 || bottomSell || Math.abs(deltaPct) >= reqDeltaRatio * 100)
    const stdBear = !churn && bearWick && effort && (d > 0 || topBuy || Math.abs(deltaPct) >= reqDeltaRatio * 100)
    const lowerLow = i >= 1 && (b.low < c[i - 1].low || (i >= 2 && b.low < c[i - 2].low))
    const higherHigh = i >= 1 && (b.high > c[i - 1].high || (i >= 2 && b.high > c[i - 2].high))
    const bullDiv = lowerLow && d > 0 && (b.close > b.open || b.close > b.low + 0.35 * range)
    const bearDiv = higherHigh && d < 0 && (b.close < b.open || b.close < b.high - 0.35 * range)
    let gold: boolean
    let purple: boolean
    if (scan) {
      // footprint engine: stacks, trapped traders and boundary absorption (with a rejection wick) count too
      const validBottom = bottomSell && (lowerWickPct >= 0.2 || b.close > b.open)
      const validTop = topBuy && (upperWickPct >= 0.2 || b.close < b.open)
      gold = !!scan.bullStack || trappedShorts || validBottom || stdBull || (bullDiv && liveRvol >= 1.1)
      purple = !!scan.bearStack || trappedLongs || validTop || stdBear || (bearDiv && liveRvol >= 1.1)
    } else {
      gold = stdBull || (bullDiv && liveRvol >= 1.25)
      purple = stdBear || (bearDiv && liveRvol >= 1.25)
    }
    const bullDrive = liveRvol >= 1.5 * aggRvolMult && bodyPct >= effBodyDrive && b.close > b.open && (d > 0 || deltaPct >= 25)
    const bearDrive = liveRvol >= 1.5 * aggRvolMult && bodyPct >= effBodyDrive && b.close < b.open && (d < 0 || deltaPct <= -25)
    const muted = !live && (effRvol < 0.7 || range < 0.4 * safeAtr)

    const condGold = gold && !bearDrive && (!purple || b.close >= b.open || d >= 0)
    const condPurple = purple && !bullDrive && !condGold
    const condBullDrive = bullDrive && !condPurple
    const condBearDrive = bearDrive && !condGold
    const condMuted = muted && !condGold && !condPurple && !condBullDrive && !condBearDrive
    states.push(condGold ? 'gold' : condPurple ? 'purple' : condMuted ? 'muted' : condBullDrive ? 'bullDrive' : condBearDrive ? 'bearDrive' : b.close >= b.open ? 'bull' : 'bear')
  }
  return { states, stacks, footprintBars }
}

/**
 * Effort vs. reward state of every bar (Section 7). Bars found in `flow` with footprint rows use the
 * footprint engine; the rest use the geometric proxy. `tfMs` is the chart timeframe; `now` decides
 * whether the last bar is still building.
 */
export function classifyCandles(c: Candle[], tfMs: number, o: BullseyeOptions = BULLSEYE_DEFAULTS, now = Date.now(), flow?: Map<number, FpBarFlow>): CandleState[] {
  return classify(c, tfMs, o, now, flow).states
}

/** Spreads one bar's buy / sell volume over the rows it traded through (the script's Gaussian kernel). */
function depositBar(buy: number[], sell: number[], b: Candle, lo: number, step: number): void {
  const share = geoShare(b)
  const bv = b.volume * share
  const sv = b.volume - bv
  if (!(bv + sv > 0)) return
  const res = buy.length - 1
  const clamp = (k: number): number => Math.max(0, Math.min(res, k))
  const rng = b.high - b.low
  if (rng <= 0) {
    const k = clamp(Math.round((b.close - lo) / step))
    buy[k] += bv
    sell[k] += sv
    return
  }
  const sg = Math.max(1e-12, rng / BELL_DIV)
  const muB = b.low + (b.close - b.low) * 0.5
  const muS = b.close + (b.high - b.close) * 0.5
  const ks = clamp(Math.floor((b.low - lo) / step))
  const ke = clamp(Math.ceil((b.high - lo) / step))
  if (ks === ke) {
    buy[ks] += bv
    sell[ks] += sv
    return
  }
  const pdf = (z: number): number => 0.3989422804014327 * Math.exp(-0.5 * z * z)
  let sumB = 0
  let sumS = 0
  for (let k = ks; k <= ke; k++) {
    const p = lo + k * step
    if (p >= b.low && p <= b.high) {
      sumB += pdf((p - muB) / sg)
      sumS += pdf((p - muS) / sg)
    }
  }
  for (let k = ks; k <= ke; k++) {
    const p = lo + k * step
    if (p >= b.low && p <= b.high) {
      if (sumB > 0) buy[k] += (bv * pdf((p - muB) / sg)) / sumB
      if (sumS > 0) sell[k] += (sv * pdf((p - muS) / sg)) / sumS
    }
  }
}

/** Puts a bar's footprint rows at their own prices (exact bought / sold volume). */
function depositRows(buy: number[], sell: number[], f: FpBarFlow & { rows: Map<number, [number, number]>; rowSize: number }, lo: number, step: number): void {
  const res = buy.length - 1
  for (const [r, [bu, se]] of f.rows) {
    const k = Math.max(0, Math.min(res, Math.floor(((r + 0.5) * f.rowSize - lo) / step)))
    buy[k] += bu
    sell[k] += se
  }
}

/** One session's profile: rows, VPOC, value area (cumulative 15 %–85 %), Dalton shape and LVN. */
export function buildProfile(bars: Candle[], kind: SessionKind, complete: boolean, flow?: Map<number, FpBarFlow>): BullseyeProfile | null {
  if (bars.length === 0) return null
  const lo = Math.min(...bars.map((b) => b.low))
  const hi = Math.max(...bars.map((b) => b.high))
  const span = Math.max(hi - lo, 1e-9)
  const step = span / ROWS
  const buy = new Array<number>(ROWS + 1).fill(0)
  const sell = new Array<number>(ROWS + 1).fill(0)
  for (const b of bars) {
    const f = flow?.get(b.time)
    if (usableRows(f)) depositRows(buy, sell, f, lo, step)
    else depositBar(buy, sell, b, lo, step)
  }
  const tot = buy.map((v, k) => v + sell[k])
  const total = tot.reduce((a, v) => a + v, 0)
  let pocB = 0
  for (let k = 1; k < tot.length; k++) if (tot[k] > tot[pocB]) pocB = k
  const poc = Math.min(hi, lo + (pocB + 0.5) * step)

  // value area by cumulative mass: VAL where 15 % of the volume lies below, VAH where 85 % does
  let val = lo
  let vah = hi
  if (total > 0) {
    let cum = 0
    let valSet = false
    for (let k = 0; k < tot.length; k++) {
      cum += tot[k]
      if (!valSet && cum >= total * 0.15) {
        val = Math.max(lo, lo + k * step)
        valSet = true
      }
      if (cum >= total * 0.85) {
        vah = Math.min(hi, lo + (k + 1) * step)
        break
      }
    }
  }

  // Dalton shape: a second balance peak far enough from the POC with a valley between them → B
  const maxTot = tot[pocB]
  const minSep = Math.max(3, Math.floor(0.15 * ROWS))
  let sec = -1
  let secV = 0
  for (let k = 1; k <= ROWS - 1; k++) {
    const v = tot[k]
    if (v >= tot[k - 1] && v >= tot[k + 1] && (v > tot[k - 1] || v > tot[k + 1]) && v >= 0.35 * maxTot) {
      if (Math.abs(k - pocB) >= minSep && v > secV) {
        secV = v
        sec = k
      }
    }
  }
  let lvn: number | null = null
  if (sec !== -1) {
    const a = Math.min(pocB, sec)
    const z = Math.max(pocB, sec)
    let minV = Number.POSITIVE_INFINITY
    let minK = -1
    for (let k = a; k <= z; k++) {
      if (tot[k] < minV) {
        minV = tot[k]
        minK = k
      }
    }
    if (minK !== -1 && minV <= 0.7 * Math.min(maxTot, secV)) lvn = lo + (minK + 0.5) * step
  }
  const pocRel = (poc - lo) / span
  const shape: ProfileShape = lvn !== null ? 'B' : pocRel > 0.65 ? 'P' : pocRel < 0.35 ? 'b' : 'D'
  const buyTot = buy.reduce((x, v) => x + v, 0)
  const sellTot = sell.reduce((x, v) => x + v, 0)
  return {
    kind,
    start: bars[0].time,
    end: bars[bars.length - 1].time,
    lo,
    hi,
    step,
    buy,
    sell,
    poc,
    vah,
    val,
    shape,
    lvn,
    deltaShare: buyTot + sellTot > 0 ? (buyTot - sellTot) / (buyTot + sellTot) : 0,
    complete,
  }
}

/** Splits the bars into alternating cash / overnight sessions (the last one is still building). */
export function splitSessions(c: Candle[]): { kind: SessionKind; bars: Candle[] }[] {
  const out: { kind: SessionKind; bars: Candle[] }[] = []
  for (const b of c) {
    const kind: SessionKind = isCashMinute(b.time) ? 'cash' : 'on'
    const last = out[out.length - 1]
    if (last && last.kind === kind) last.bars.push(b)
    else out.push({ kind, bars: [b] })
  }
  return out
}

/** Stacked imbalances as shelves: each runs until a later bar closes through its far side. */
export function projectShelves(c: Candle[], stacks: ClassifyOut['stacks'], max = MAX_SHELVES): ImbalanceShelf[] {
  const shelves: ImbalanceShelf[] = stacks.map((s) => {
    let end: number | null = null
    for (let k = s.i + 1; k < c.length; k++) {
      if (s.side === 'bull' ? c[k].close < s.lo : c[k].close > s.hi) {
        end = c[k].time
        break
      }
    }
    return { side: s.side, from: c[s.i].time, lo: s.lo, hi: s.hi, end }
  })
  // keep every active shelf (newest first, up to `max`) and the most recent mitigated ones up to the cap
  const active = shelves.filter((s) => s.end === null).slice(-max)
  const done = shelves.filter((s) => s.end !== null).slice(-Math.max(0, max - active.length))
  return [...done, ...active]
}

/** Everything the indicator draws, from the chart's candles (and footprint rows where there are some). */
export function computeBullseye(
  c: Candle[],
  tfMs: number,
  o: BullseyeOptions = BULLSEYE_DEFAULTS,
  keepSessions = 16,
  now = Date.now(),
  flow?: Map<number, FpBarFlow>,
): BullseyeResult {
  const cls = classify(c, tfMs, o, now, flow)
  const sessions = splitSessions(c)
  const recent = sessions.slice(-keepSessions)
  const profiles = recent.map((s, i) => buildProfile(s.bars, s.kind, i < recent.length - 1, flow)).filter((p): p is BullseyeProfile => p !== null)

  const levels: BullseyeLevels = {
    onHigh: null,
    onLow: null,
    halfBack: null,
    onPoc: null,
    pdHigh: null,
    pdLow: null,
    priorCashPoc: null,
    priorCashVah: null,
    priorCashVal: null,
    confluentPoc: null,
    virginPoc: null,
  }
  const current = profiles[profiles.length - 1]
  const done = profiles.filter((p) => p.complete)
  // overnight: the developing one while it runs, else the overnight that just finished
  const on = current && current.kind === 'on' ? current : [...done].reverse().find((p) => p.kind === 'on')
  if (on) {
    levels.onHigh = on.hi
    levels.onLow = on.lo
    levels.halfBack = (on.hi + on.lo) / 2
    levels.onPoc = on.poc
  }
  const cash = [...done].reverse().find((p) => p.kind === 'cash')
  if (cash) {
    levels.pdHigh = cash.hi
    levels.pdLow = cash.lo
    levels.priorCashPoc = cash.poc
    levels.priorCashVah = cash.vah
    levels.priorCashVal = cash.val
  }
  const last = c[c.length - 1]
  if (last && levels.priorCashPoc !== null && levels.onPoc !== null) {
    const tol = Math.max(last.close * 0.0015, 1e-9) // the script's 24/7 (crypto) cluster tolerance
    if (Math.abs(levels.priorCashPoc - levels.onPoc) <= tol) levels.confluentPoc = (levels.priorCashPoc + levels.onPoc) / 2
  }
  const lastDone = done[done.length - 1]
  if (lastDone) {
    const touched = c.some((b) => b.time > lastDone.end && b.low <= lastDone.poc && b.high >= lastDone.poc)
    if (!touched) levels.virginPoc = { price: lastDone.poc, from: lastDone.end }
  }
  return { states: cls.states, profiles, levels, shelves: projectShelves(c, cls.stacks), footprintBars: cls.footprintBars }
}
