/**
 * Deep Profile — pure model (no DOM). A DeepCharts-style volume / delta
 * profile study: see deepProfile.ts for the canvas overlay that draws it.
 *
 * Data. Profiles are built from "buckets", one per chart candle:
 *   - exact buckets come from the trade tape (recorded history + live
 *     prints), each print or taker order at its real price and taker side;
 *   - estimated buckets come from the candle itself where no tape covers it:
 *     its volume spread evenly over the price rows it spans, split buy/sell
 *     by real taker buy volume when the feed has it, else close location.
 * A candle only counts as exact when the tape covers its whole span — a
 * partly recorded candle is estimated and its prints dropped, so nothing is
 * counted twice. Size filters and "number of trades" need real trades, so
 * estimated buckets are left out while a size filter is on (the profile says
 * how much of it was estimated either way).
 *
 * Periods. Day boundaries follow the symbol's trading-day open (gold: 18:00
 * New York, US daylight saving included — see core/session.ts). A day can be
 * split once ("Splitted", e.g. at the RTH open) or twice ("Triple"), at
 * wall-clock times in New York, IST or UTC. Profiles can be merged with /
 * split from their neighbours; merges are stored as the start times of the
 * periods joined onto the one before them, so they survive reloads.
 */
import type { Candle } from '../core/types'
import { nyOffsetMinutes } from './nyClock'

export type DpVbpType = 'volume' | 'bidask' | 'delta' | 'deltaVolume'
export type DpPeriod = 'latest' | 'multiple' | 'composite' | 'visible' | 'custom'
export type DpLengthType = 'minutes' | 'hours' | 'days' | 'weeks' | 'months'
/** Volume = every print; Order = prints merged into taker orders; Aggregate = orders merged into clusters (takerOrders.ts). */
export type DpInput = 'volume' | 'order' | 'aggregate'
export type DpSplitMode = 'none' | 'splitted' | 'triple'
export type DpZone = 'NY' | 'IST' | 'UTC'

const MIN_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

// ---------------------------------------------------------------- clocks ----

/** Minutes a zone's wall clock is ahead of UTC at instant `t`. */
export type OffsetFn = (t: number) => number

export function zoneOffset(zone: DpZone): OffsetFn {
  if (zone === 'NY') return nyOffsetMinutes
  if (zone === 'IST') return () => 330
  return () => 0
}

/** Instant at wall-clock minute `minuteOfDay` on local day number `day` (days since 1970-01-01 in that zone). */
export function wallToUtc(day: number, minuteOfDay: number, off: OffsetFn): number {
  const wall = day * DAY_MS + minuteOfDay * MIN_MS
  let t = wall - off(wall) * MIN_MS
  t = wall - off(t) * MIN_MS // second pass settles the day the clocks change
  return t
}

/** "HH:MM" → minutes after midnight (null when malformed). */
export function parseHhMm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  return h < 24 && mi < 60 ? h * 60 + mi : null
}

export interface DpPeriodSpec {
  lengthType: DpLengthType
  lengthValue: number
  /** Trading-day open: wall-clock minute in `anchorOffset`'s zone (gold: 18:00 NY). */
  anchorMinute: number
  anchorOffset: OffsetFn
  splitMode: DpSplitMode
  /** Split times, minutes after midnight in `splitOffset`'s zone (one used for Splitted, two for Triple). */
  splitMinutes: number[]
  splitOffset: OffsetFn
}

/**
 * Maps an instant to the start of the period holding it. Splits apply only to
 * 1-day periods (a split of a multi-day or intraday profile is meaningless).
 */
export class PeriodClock {
  private readonly spec: DpPeriodSpec
  private readonly len: number
  private readonly splitCache = new Map<number, number[]>()

  constructor(spec: DpPeriodSpec) {
    this.spec = spec
    this.len = Math.max(1, Math.floor(spec.lengthValue))
  }

  /** Index of the trading day holding `t` (anchor-zone day number of its open). */
  dayIndex(t: number): number {
    const { anchorMinute, anchorOffset } = this.spec
    let idx = Math.floor((t + anchorOffset(t) * MIN_MS - anchorMinute * MIN_MS) / DAY_MS)
    if (this.dayStart(idx) > t) idx--
    else if (this.dayStart(idx + 1) <= t) idx++
    return idx
  }

  dayStart(idx: number): number {
    return wallToUtc(idx, this.spec.anchorMinute, this.spec.anchorOffset)
  }

  /** Calendar day a trading day is named after: an evening open (gold's 18:00) trades for the next date. */
  private tradingDate(idx: number): number {
    return idx + (this.spec.anchorMinute >= 12 * 60 ? 1 : 0)
  }

  private fromTradingDate(day: number): number {
    return day - (this.spec.anchorMinute >= 12 * 60 ? 1 : 0)
  }

  periodStart(t: number): number {
    const { lengthType } = this.spec
    const len = this.len
    if (lengthType === 'minutes' || lengthType === 'hours') {
      const size = len * (lengthType === 'minutes' ? MIN_MS : HOUR_MS)
      const off = this.spec.anchorOffset(t) * MIN_MS
      const local = t + off
      return Math.floor(local / size) * size - off
    }
    const idx = this.dayIndex(t)
    if (lengthType === 'days') {
      const start = this.dayStart(Math.floor(idx / len) * len)
      if (len !== 1 || this.spec.splitMode === 'none') return start
      let seg = start
      for (const b of this.splits(idx)) if (b <= t) seg = b
      return seg
    }
    const td = this.tradingDate(idx)
    if (lengthType === 'weeks') {
      const week = Math.floor((td + 3) / 7) // Monday-based; day 0 (1970-01-01) was a Thursday
      const firstMonday = Math.floor(week / len) * len * 7 - 3
      return this.dayStart(this.fromTradingDate(firstMonday))
    }
    const d = new Date(td * DAY_MS)
    const month = d.getUTCFullYear() * 12 + d.getUTCMonth()
    const g = Math.floor(month / len) * len
    const first = Date.UTC(Math.floor(g / 12), g % 12, 1) / DAY_MS
    return this.dayStart(this.fromTradingDate(first))
  }

  /** Split boundaries strictly inside trading day `idx`, ascending. */
  splits(idx: number): number[] {
    const hit = this.splitCache.get(idx)
    if (hit) return hit
    const { splitMode, splitMinutes, splitOffset } = this.spec
    const start = this.dayStart(idx)
    const end = this.dayStart(idx + 1)
    const wanted = splitMode === 'splitted' ? splitMinutes.slice(0, 1) : splitMode === 'triple' ? splitMinutes.slice(0, 2) : []
    const localDay = Math.floor((start + splitOffset(start) * MIN_MS) / DAY_MS)
    const out = new Set<number>()
    for (const m of wanted) {
      for (let d = localDay - 1; d <= localDay + 2; d++) {
        const b = wallToUtc(d, m, splitOffset)
        if (b > start && b < end) out.add(b)
      }
    }
    const list = [...out].sort((a, b) => a - b)
    if (this.splitCache.size > 4000) this.splitCache.clear()
    this.splitCache.set(idx, list)
    return list
  }
}

// --------------------------------------------------------------- buckets ----

/** One taker trade unit: a print, a taker order or an aggregated cluster. */
export interface DpUnit {
  time: number
  side: 'buy' | 'sell'
  qty: number
  /** Volume per price touched; a single print has one level. */
  levels: [number, number][]
}

export interface DpBucket {
  time: number
  end: number
  /** True when built from the candle (no tape for its whole span). */
  est: boolean
  /** Exact: one entry per price. Estimated: none (see lo/hi). */
  prices: Float64Array
  buy: Float64Array
  sell: Float64Array
  /** Estimated buckets: the candle's range and its buy/sell metric, spread over the rows at build time. */
  lo: number
  hi: number
  estBuy: number
  estSell: number
}

export interface DpFilter {
  /** Count trades (units) instead of summing volume. */
  countTrades: boolean
  /** Units smaller than this are ignored (0 = off). */
  minFilter: number
  /** Units larger than this are ignored (0 = off). */
  maxFilter: number
}

export const filterActive = (f: DpFilter): boolean => f.minFilter > 0 || f.maxFilter > 0

const passes = (u: DpUnit, f: DpFilter): boolean => (f.minFilter <= 0 || u.qty >= f.minFilter) && (f.maxFilter <= 0 || u.qty <= f.maxFilter)

/** Is [from, to) entirely inside one recorded span? `spans` sorted, non-overlapping. */
function covered(spans: [number, number][], from: number, to: number): boolean {
  let lo = 0
  let hi = spans.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (spans[mid][1] < from) lo = mid + 1
    else if (spans[mid][0] > from) hi = mid - 1
    else return spans[mid][1] >= to
  }
  return false
}

function lowerBound(units: DpUnit[], t: number): number {
  let lo = 0
  let hi = units.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (units[mid].time < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

function candleBuyShare(c: Candle): number {
  if (c.buyVolume !== undefined && c.volume > 0) return Math.max(0, Math.min(1, c.buyVolume / c.volume))
  const range = c.high - c.low
  return range > 0 ? (c.close - c.low) / range : 0.5
}

/**
 * One bucket per candle in `candles[from..]`. `units` must be time-sorted;
 * `spans` are the tape's exactly-recorded ranges (sorted, merged). `barMs`
 * is the candle interval — used as the last candle's span.
 */
export function buildBuckets(candles: Candle[], units: DpUnit[], spans: [number, number][], barMs: number, f: DpFilter, from = 0): DpBucket[] {
  const out: DpBucket[] = []
  const filtered = filterActive(f)
  for (let i = from; i < candles.length; i++) {
    const c = candles[i]
    const end = i + 1 < candles.length ? candles[i + 1].time : c.time + barMs
    if (covered(spans, c.time, end)) {
      const acc = new Map<number, [number, number]>()
      for (let k = lowerBound(units, c.time); k < units.length && units[k].time < end; k++) {
        const u = units[k]
        if (!passes(u, f)) continue
        // A unit counts once in trade-count mode, at its largest price level.
        if (f.countTrades) {
          let best = u.levels[0]
          for (const l of u.levels) if (l[1] > best[1]) best = l
          const e = acc.get(best[0]) ?? [0, 0]
          e[u.side === 'buy' ? 0 : 1] += 1
          acc.set(best[0], e)
        } else {
          for (const [p, q] of u.levels) {
            const e = acc.get(p) ?? [0, 0]
            e[u.side === 'buy' ? 0 : 1] += q
            acc.set(p, e)
          }
        }
      }
      const prices = [...acc.keys()].sort((a, b) => a - b)
      out.push({
        time: c.time,
        end,
        est: false,
        prices: Float64Array.from(prices),
        buy: Float64Array.from(prices, (p) => acc.get(p)![0]),
        sell: Float64Array.from(prices, (p) => acc.get(p)![1]),
        lo: 0,
        hi: 0,
        estBuy: 0,
        estSell: 0,
      })
      continue
    }
    // Estimate from the candle. A size filter can't be applied to a bar's
    // total, so filtered profiles skip it; trade counts need tradeCount.
    let metric = c.volume
    if (filtered) metric = 0
    else if (f.countTrades) metric = c.tradeCount ?? 0
    const share = candleBuyShare(c)
    out.push({
      time: c.time,
      end,
      est: true,
      prices: new Float64Array(0),
      buy: new Float64Array(0),
      sell: new Float64Array(0),
      lo: c.low,
      hi: c.high,
      estBuy: metric * share,
      estSell: metric * (1 - share),
    })
  }
  return out
}

// -------------------------------------------------------------- profiles ----

export interface DpProfile {
  /** Start of its first period (or the custom / visible range start). */
  start: number
  /** Where its box ends: the next period's start, or the last bucket's end. */
  end: number
  /** Start times of the base periods merged into it (one unless merged). */
  bases: number[]
  rowSize: number
  /** Price of row 0's lower edge; row r covers [rowLo + r·rowSize, rowLo + (r+1)·rowSize). */
  rowLo: number
  buy: Float64Array
  sell: Float64Array
  pocRow: number
  vahRow: number
  valRow: number
  totalBuy: number
  totalSell: number
  /** Share of the metric that came from candle estimates, 0..1. */
  estShare: number
  /** Developing POC: [bucket time, POC row] at each change. */
  developing: [number, number][]
  peaks: number[]
  valleys: number[]
  /** For custom profiles: its index in the custom range list. */
  customIndex?: number
}

export interface DpBuildOptions {
  rowSize: number
  valueAreaPct: number
  /** 1 (every bump) … 10 (only the largest nodes). */
  sensitivity: number
  detectNodes: boolean
}

const rowOf = (price: number, rowSize: number): number => Math.floor(price / rowSize + 1e-9)

/** POC + value area over `metric` (smallest contiguous band around the POC holding `pct` of the total). */
export function valueArea(metric: ArrayLike<number>, pct: number): { pocRow: number; vahRow: number; valRow: number } {
  const n = metric.length
  let poc = 0
  let total = 0
  for (let r = 0; r < n; r++) {
    total += metric[r]
    if (metric[r] > metric[poc]) poc = r
  }
  let lo = poc
  let hi = poc
  let got = metric[poc] ?? 0
  const target = total * pct
  while (got < target && (lo > 0 || hi < n - 1)) {
    const below = lo > 0 ? metric[lo - 1] : -1
    const above = hi < n - 1 ? metric[hi + 1] : -1
    if (above >= below) got += metric[++hi]
    else got += metric[--lo]
  }
  return { pocRow: poc, vahRow: hi, valRow: lo }
}

/**
 * High- and low-volume nodes. The histogram is smoothed over ±`sensitivity`
 * rows, so a higher sensitivity irons out small bumps and keeps only the main
 * nodes. A peak is the highest smoothed row within ±2·radius holding at least
 * 15% of the largest row; a valley is the lowest row between two neighbouring
 * peaks, kept when it is at most 70% of the smaller of the two.
 */
export function findNodes(metric: ArrayLike<number>, sensitivity: number): { peaks: number[]; valleys: number[] } {
  const n = metric.length
  if (n < 5) return { peaks: [], valleys: [] }
  const radius = Math.max(1, Math.round(sensitivity))
  const sm = new Float64Array(n)
  for (let r = 0; r < n; r++) {
    let s = 0
    let w = 0
    for (let k = -radius; k <= radius; k++) {
      const j = r + k
      if (j < 0 || j >= n) continue
      const wk = radius + 1 - Math.abs(k) // triangular kernel
      s += metric[j] * wk
      w += wk
    }
    sm[r] = s / w
  }
  let max = 0
  for (let r = 0; r < n; r++) if (sm[r] > max) max = sm[r]
  if (max <= 0) return { peaks: [], valleys: [] }
  const win = 2 * radius
  const peaks: number[] = []
  for (let r = 0; r < n; r++) {
    if (sm[r] < 0.15 * max) continue
    let isMax = true
    for (let k = Math.max(0, r - win); k <= Math.min(n - 1, r + win) && isMax; k++) {
      if (sm[k] > sm[r] || (sm[k] === sm[r] && k < r)) isMax = false
    }
    if (isMax) peaks.push(r)
  }
  const valleys: number[] = []
  for (let i = 0; i + 1 < peaks.length; i++) {
    let lo = peaks[i] + 1
    for (let r = peaks[i] + 1; r < peaks[i + 1]; r++) if (sm[r] < sm[lo]) lo = r
    if (lo < peaks[i + 1] && sm[lo] <= 0.7 * Math.min(sm[peaks[i]], sm[peaks[i + 1]])) valleys.push(lo)
  }
  return { peaks, valleys }
}

/** Accumulate `buckets` into one profile. Returns null when it holds nothing. */
export function buildProfile(buckets: DpBucket[], start: number, end: number, bases: number[], o: DpBuildOptions): DpProfile | null {
  const rs = o.rowSize
  if (!(rs > 0) || buckets.length === 0) return null
  let rMin = Infinity
  let rMax = -Infinity
  for (const b of buckets) {
    if (b.est) {
      if (b.estBuy + b.estSell <= 0) continue
      rMin = Math.min(rMin, rowOf(b.lo, rs))
      rMax = Math.max(rMax, rowOf(b.hi, rs))
    } else if (b.prices.length) {
      rMin = Math.min(rMin, rowOf(b.prices[0], rs))
      rMax = Math.max(rMax, rowOf(b.prices[b.prices.length - 1], rs))
    }
  }
  if (!isFinite(rMin)) return null
  const n = rMax - rMin + 1
  if (n > 20_000) return null // row size far too small for this range — caller picks a coarser one
  const buy = new Float64Array(n)
  const sell = new Float64Array(n)
  const tot = new Float64Array(n)
  let estTotal = 0
  let total = 0
  let poc = -1
  const developing: [number, number][] = []
  const bump = (r: number, bv: number, sv: number): void => {
    buy[r] += bv
    sell[r] += sv
    tot[r] += bv + sv
    if (poc < 0 || tot[r] > tot[poc]) poc = r
  }
  for (const b of buckets) {
    if (b.est) {
      const m = b.estBuy + b.estSell
      if (m <= 0) continue
      const r0 = rowOf(b.lo, rs) - rMin
      const r1 = rowOf(b.hi, rs) - rMin
      const k = r1 - r0 + 1
      for (let r = r0; r <= r1; r++) bump(r, b.estBuy / k, b.estSell / k)
      estTotal += m
      total += m
    } else {
      for (let i = 0; i < b.prices.length; i++) {
        bump(rowOf(b.prices[i], rs) - rMin, b.buy[i], b.sell[i])
        total += b.buy[i] + b.sell[i]
      }
    }
    if (poc >= 0 && (developing.length === 0 || developing[developing.length - 1][1] !== poc)) developing.push([b.time, poc])
  }
  if (total <= 0) return null
  const va = valueArea(tot, o.valueAreaPct)
  const nodes = o.detectNodes ? findNodes(tot, o.sensitivity) : { peaks: [], valleys: [] }
  let totalBuy = 0
  let totalSell = 0
  for (let r = 0; r < n; r++) {
    totalBuy += buy[r]
    totalSell += sell[r]
  }
  return {
    start,
    end,
    bases,
    rowSize: rs,
    rowLo: rMin * rs,
    buy,
    sell,
    ...va,
    totalBuy,
    totalSell,
    estShare: estTotal / total,
    developing,
    ...nodes,
  }
}

// ------------------------------------------------------------ grouping ----

export interface DpGroup {
  bases: number[]
  /** Index range [i0, i1) into the buckets. */
  i0: number
  i1: number
}

/**
 * Buckets → base periods → merged groups. `joined` holds base-period starts
 * merged onto the period before them.
 */
export function groupPeriods(buckets: DpBucket[], clock: PeriodClock, joined: ReadonlySet<number>): DpGroup[] {
  const groups: DpGroup[] = []
  let cur: DpGroup | null = null
  let curBase = NaN
  for (let i = 0; i < buckets.length; i++) {
    const p = clock.periodStart(buckets[i].time)
    if (p === curBase && cur) {
      cur.i1 = i + 1
      continue
    }
    curBase = p
    if (cur && joined.has(p)) {
      cur.bases.push(p)
      cur.i1 = i + 1
      continue
    }
    cur = { bases: [p], i0: i, i1: i + 1 }
    groups.push(cur)
  }
  return groups
}

/** Merge / split edits on the joined-period set, for the profile made of `bases` (and the next profile's bases). */
export function editJoins(
  joined: number[],
  action: 'merge-' | 'merge+' | 'split-' | 'split+',
  bases: number[],
  nextBases: number[] | null,
): number[] {
  const set = new Set(joined)
  if (action === 'merge-') set.add(bases[0])
  else if (action === 'merge+' && nextBases) set.add(nextBases[0])
  else if (action === 'split-' && bases.length > 1) set.delete(bases[1])
  else if (action === 'split+' && bases.length > 1) set.delete(bases[bases.length - 1])
  return [...set].sort((a, b) => a - b)
}

/** Buckets overlapping [from, to). */
export function bucketsIn(buckets: DpBucket[], from: number, to: number): DpBucket[] {
  return buckets.filter((b) => b.end > from && b.time < to)
}

/** Recorded spans + the live span, sorted and merged. */
export function mergeSpans(spans: [number, number][]): [number, number][] {
  const s = spans.filter((x) => x[1] > x[0]).sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const x of s) {
    const last = out[out.length - 1]
    if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1])
    else out.push([x[0], x[1]])
  }
  return out
}

/**
 * Auto row size: about `rowPx` pixels per row at the current price scale,
 * snapped up to a tidy multiple of the tick (1, 2, 2.5, 5 × 10ⁿ ticks), then
 * × `factor`. Manual: `manualTicks × factor` ticks.
 */
export function rowSizeFor(tick: number, auto: boolean, pricePerPx: number, rowPx: number, manualTicks: number, factor: number): number {
  const t = tick > 0 ? tick : 0.01
  const f = Math.max(1, Math.floor(factor))
  if (!auto) return t * Math.max(1, Math.floor(manualTicks)) * f
  const raw = Math.max(t, pricePerPx * rowPx) / t
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  let ticks = mag
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * mag >= raw - 1e-9) {
      ticks = m * mag
      break
    }
  }
  ticks = Math.max(1, Math.round(ticks))
  return t * ticks * f
}
