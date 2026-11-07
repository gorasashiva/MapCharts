/**
 * Deep Stats — DeepCharts-style per-bar order-flow statistics
 * (https://www.deepcharts.com/helpcenter/article/deep-stats), computed from
 * taker units (single prints, rebuilt taker orders, or aggregated orders;
 * takerOrders.ts) inside each candle. Only candles whose whole span is covered
 * by recorded / live tape get numbers — no candle estimates.
 *
 * Values (per bar):
 *   totVol / bidVol / askVol   total, sell-aggressor (hit the bid), buy-aggressor (lifted the ask) volume
 *   delta                      askVol − bidVol
 *   maxDelta / minDelta        highest / lowest the running delta reached inside the bar
 *   totNT / deltaNT            number of units, and buy units − sell units
 *   deltaHL                    (high − low) in ticks
 *   deltaPct                   delta / totVol × 100
 *   cvd ("Delta Dly")          cumulative delta since the trading-day open (resets each session)
 *   volPerSec ("Vol(s)")       totVol / the bar's elapsed seconds (the live bar: so far)
 *   cotHigh / cotLow           delta since the bar last made its high / its low (close of trade)
 *   cotBar                     cotHigh on bullish bars, cotLow on bearish bars
 *   timeSec ("Time(s)")        seconds between the bar's first and last unit
 *   highRatio / lowRatio       ask volume one row under the high ÷ ask volume in the high row;
 *                              bid volume one row over the low ÷ bid volume in the low row
 *                              (rows = footprint rows: on crypto most single ticks never trade)
 *                              (big = a thin extreme print: exhaustion)
 *   barRatio                   highRatio on bearish bars, lowRatio on bullish bars
 *   totEffort / deltaEffort    totVol / deltaHL and delta / deltaHL (volume per tick of range)
 * The article leaves COT H / COT L and the ratios loosely worded; these readings
 * match its own notes (COT H negative on bearish bars, COT L positive on bullish).
 */
import type { Candle } from '../core/types'
import { sessionIndex, sessionOpenHourUTC } from '../core/session'
import type { DpUnit } from './deepProfileModel'

export const DEEP_STATS_KEYS = [
  'totVol', 'bidVol', 'askVol', 'delta', 'maxDelta', 'minDelta', 'totNT', 'deltaNT', 'deltaHL', 'deltaPct',
  'cvd', 'volPerSec', 'cotHigh', 'cotLow', 'cotBar', 'timeSec', 'barRatio', 'highRatio', 'lowRatio', 'totEffort', 'deltaEffort',
] as const
export type DeepStatKey = (typeof DEEP_STATS_KEYS)[number]

/** Row labels, as DeepCharts names them. */
export const DEEP_STAT_LABELS: Record<DeepStatKey, string> = {
  totVol: 'Tot Vol', bidVol: 'Bid Vol', askVol: 'Ask Vol', delta: 'Delta Vol', maxDelta: 'Max Delta', minDelta: 'Min Delta',
  totNT: 'Tot NT', deltaNT: 'Delta NT', deltaHL: 'Delta HL', deltaPct: 'Delta %', cvd: 'Delta Dly', volPerSec: 'Vol(s)',
  cotHigh: 'COT H', cotLow: 'COT L', cotBar: 'COT Bar', timeSec: 'Time(s)', barRatio: 'Bar Ratio', highRatio: 'High Ratio',
  lowRatio: 'Low Ratio', totEffort: 'Total Effort', deltaEffort: 'Delta Effort',
}

/** Signed values are coloured by sign (buyers / sellers); the rest by how far above normal they are. */
export const SIGNED_STATS = new Set<DeepStatKey>(['delta', 'maxDelta', 'minDelta', 'deltaNT', 'deltaPct', 'cvd', 'cotHigh', 'cotLow', 'cotBar', 'deltaEffort'])

export type DeepStatsRow = Record<DeepStatKey, number>

export interface DeepStatsFilter {
  /** Units smaller / larger than this are ignored (0 = off). */
  minFilter: number
  maxFilter: number
}

function lowerBound(units: DpUnit[], t: number): number {
  let lo = 0
  let hi = units.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (units[m].time < t) lo = m + 1
    else hi = m
  }
  return lo
}

/** Is [from, to) inside one recorded span? `spans` sorted and merged. */
function covered(spans: [number, number][], from: number, to: number): boolean {
  let lo = 0
  let hi = spans.length - 1
  while (lo <= hi) {
    const m = (lo + hi) >> 1
    if (spans[m][1] < from) lo = m + 1
    else if (spans[m][0] > from) hi = m - 1
    else return spans[m][1] >= to
  }
  return false
}

/** Stats of one bar's units (time-ordered). `tick` = price step (Delta HL); `row` = footprint row for the ratios. `elapsedSec` = the bar's length so far. */
export function barStats(units: DpUnit[], tick: number, elapsedSec: number, row = tick): Omit<DeepStatsRow, 'cvd'> | null {
  if (!units.length) return null
  let ask = 0
  let bid = 0
  let ntAsk = 0
  let ntBid = 0
  let run = 0
  let maxD = 0
  let minD = 0
  let hi = -Infinity
  let lo = Infinity
  let sinceHigh = 0
  let sinceLow = 0
  const askAt = new Map<number, number>()
  const bidAt = new Map<number, number>()
  const key = (p: number): number => Math.floor(p / row + 1e-9)
  for (const u of units) {
    const s = u.side === 'buy' ? 1 : -1
    if (s > 0) {
      ask += u.qty
      ntAsk++
    } else {
      bid += u.qty
      ntBid++
    }
    for (const [p, q] of u.levels) {
      const m = s > 0 ? askAt : bidAt
      const k = key(p)
      m.set(k, (m.get(k) ?? 0) + q)
      // a new extreme restarts the delta counted from it (this unit's own volume included below)
      if (p > hi) {
        hi = p
        sinceHigh = 0
      }
      if (p < lo) {
        lo = p
        sinceLow = 0
      }
    }
    run += s * u.qty
    sinceHigh += s * u.qty
    sinceLow += s * u.qty
    maxD = Math.max(maxD, run)
    minD = Math.min(minD, run)
  }
  const tot = ask + bid
  const delta = ask - bid
  const ticks = Math.max(0, Math.round((hi - lo) / tick))
  const hk = key(hi)
  const lk = key(lo)
  const ratio = (num: number, den: number): number => (den > 0 ? num / den : num > 0 ? Infinity : 0)
  const highRatio = ratio(askAt.get(hk - 1) ?? 0, askAt.get(hk) ?? 0)
  const lowRatio = ratio(bidAt.get(lk + 1) ?? 0, bidAt.get(lk) ?? 0)
  const lastU = units[units.length - 1]
  const lastPx = lastU.levels[lastU.levels.length - 1][0]
  const bull = lastPx >= units[0].levels[0][0]
  return {
    totVol: tot, bidVol: bid, askVol: ask, delta, maxDelta: maxD, minDelta: minD,
    totNT: ntAsk + ntBid, deltaNT: ntAsk - ntBid, deltaHL: ticks, deltaPct: tot > 0 ? (delta / tot) * 100 : 0,
    volPerSec: elapsedSec > 0 ? tot / elapsedSec : 0,
    cotHigh: sinceHigh, cotLow: sinceLow, cotBar: bull ? sinceHigh : sinceLow,
    timeSec: (lastU.time - units[0].time) / 1000,
    highRatio, lowRatio, barRatio: bull ? lowRatio : highRatio,
    totEffort: ticks > 0 ? tot / ticks : tot, deltaEffort: ticks > 0 ? delta / ticks : delta,
  }
}

/**
 * Per-candle stats (null where the candle isn't fully covered by tape, or had no units).
 * `units` time-sorted; `spans` merged recorded spans (live: [liveFrom, Infinity]).
 * Delta Dly accumulates over covered bars since the session open (core/session.ts, DST aware).
 */
export function computeDeepStats(candles: Candle[], units: DpUnit[], spans: [number, number][], barMs: number, symbol: string, tick: number, f: DeepStatsFilter, now = Date.now(), row = tick): (DeepStatsRow | null)[] {
  const out: (DeepStatsRow | null)[] = []
  let session = Number.NaN
  let cvd = 0
  const pass = (u: DpUnit): boolean => (f.minFilter <= 0 || u.qty >= f.minFilter) && (f.maxFilter <= 0 || u.qty <= f.maxFilter)
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const end = i + 1 < candles.length ? candles[i + 1].time : c.time + barMs
    const s = sessionIndex(c.time, sessionOpenHourUTC(symbol, c.time))
    if (s !== session) {
      session = s
      cvd = 0
    }
    const live = i === candles.length - 1 && now < end
    if (!covered(spans, c.time, live ? Math.min(end, now) : end)) {
      out.push(null)
      continue
    }
    const bu: DpUnit[] = []
    for (let k = lowerBound(units, c.time); k < units.length && units[k].time < end; k++) if (pass(units[k])) bu.push(units[k])
    const elapsed = ((live ? Math.max(c.time + 1000, now) : end) - c.time) / 1000
    const st = barStats(bu, tick, elapsed, row)
    if (!st) {
      out.push(null)
      continue
    }
    cvd += st.delta
    out.push({ ...st, cvd })
  }
  return out
}

/**
 * Colour strength 0..1 per cell: how unusual the value is against the shown bars.
 * Signed values: |v| / (k·σ) of the values around zero; others: (v − mean) / (k·σ), above-normal only.
 */
export function cellIntensity(values: number[], key: DeepStatKey, devStd: number): (v: number) => number {
  const xs = values.filter((v) => Number.isFinite(v))
  if (xs.length < 3) return () => 0
  const signed = SIGNED_STATS.has(key)
  const mean = signed ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length)
  if (!(sd > 0)) return () => 0
  const k = Math.max(0.1, devStd) * sd
  return (v: number): number => {
    if (!Number.isFinite(v)) return 1
    const z = signed ? Math.abs(v) / k : (v - mean) / k
    return Math.max(0, Math.min(1, z))
  }
}

/** Compact number for a cell: 1.2K, 3.4M, small values with sensible decimals. */
export function fmtStat(v: number, key: DeepStatKey, auto: boolean): string {
  if (!Number.isFinite(v)) return '∞'
  if (key === 'deltaPct') return `${v.toFixed(0)}%`
  if (key === 'highRatio' || key === 'lowRatio' || key === 'barRatio') return v.toFixed(2)
  if (key === 'deltaHL' || key === 'totNT' || key === 'deltaNT' || key === 'timeSec') return String(Math.round(v))
  const a = Math.abs(v)
  if (auto) {
    if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`
    if (a >= 1e4) return `${(v / 1e3).toFixed(1)}K`
  }
  return a >= 100 ? String(Math.round(v)) : a >= 1 ? v.toFixed(1) : v.toFixed(2)
}
