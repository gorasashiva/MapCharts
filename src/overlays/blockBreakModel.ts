/**
 * Block Break — a FRESH 1H/4H block (hlBlocksModel.ts) broken with footprint
 * confirmation. The setup found on the recorded tape (research/block-swing-study.ts,
 * Oct–Nov 2026, XAUT / BTC / ETH): watched levels break more often than they hold,
 * and a break carried on when the order flow pushed through it.
 *
 *   1. A block forms (1H and 4H highs, or lows, line up) and price later touches it
 *      for the first time, arriving from outside (a touch that starts inside the zone
 *      doesn't count, and the block is spent).
 *   2. The touch minute + the next `windowMin - 1` minutes form the window.
 *   3. Signal when the window closes beyond the FAR edge of the block (acceptance)
 *      and some minute in the window shows a stacked imbalance of `stackRows`+ rows
 *      in the break direction (diagonal: buy at row r ≥ `imbalance` × sell at r-1,
 *      or sell at r ≥ `imbalance` × buy at r+1, each row ≥ `minRowShare` of the bar).
 *   4. Entry = the window's close, in the break direction. Stop = `stopBufPct`%
 *      beyond the block's NEAR edge; skipped when that is closer than `minStopPct`%.
 *      T1 = `t1R` R (marked), T2 = `t2R` R (exit), or the close after `holdHours`.
 *
 * Bars are 1-minute bars with per-price taker buy / sell volume, built from the
 * trade tape (recorded + live). Pure: a signal uses bars up to its window's end only,
 * so bar replay shows exactly what was live.
 */
import type { Candle } from '../core/types'
import { computeHlBlocks, HL_BLOCKS_DEFAULTS, type HlBlocksOptions, type HlZone } from './hlBlocksModel'

const MIN = 60_000

/** One-minute bar with per-price taker volume: row price -> [taker buy, taker sell]. */
export interface BbBar extends Candle {
  rows: Map<number, [number, number]>
}

export interface BlockBreakOptions {
  blocks: HlBlocksOptions
  windowMin: number
  stackRows: number
  imbalance: number
  minRowShare: number
  /** Footprint row height in price; 0 = automatic (≈ price / 8000 on a 1-2-5 step). */
  rowSize: number
  stopBufPct: number
  minStopPct: number
  t1R: number
  t2R: number
  holdHours: number
}

export const BLOCK_BREAK_DEFAULTS: BlockBreakOptions = {
  blocks: HL_BLOCKS_DEFAULTS,
  windowMin: 5,
  stackRows: 3,
  imbalance: 3,
  minRowShare: 0.02,
  rowSize: 0,
  stopBufPct: 0.1,
  minStopPct: 0.15,
  t1R: 2,
  t2R: 3,
  holdHours: 4,
}

export type BbOutcome = 'open' | 't2' | 'stop' | 'time'

export interface BbSignal {
  zone: HlZone
  /** 1 = long (broke a block upward), -1 = short. */
  dir: 1 | -1
  touchTime: number
  /** Window end: the entry time. */
  entryTime: number
  entry: number
  stop: number
  t1: number
  t2: number
  /** Longest stacked imbalance in the break direction inside the window (rows). */
  stack: number
  t1Time: number | null
  exitTime: number | null
  exitPrice: number | null
  outcome: BbOutcome
  /** Result in R (at the exit, or the latest close while open). */
  r: number
  /** When an open trade is closed out: entry + hold. */
  expiry: number
}

/** A fresh block touched whose window is still running (live only). */
export interface BbWatch {
  zone: HlZone
  touchTime: number
  /** 1 = price came from above. */
  from: 1 | -1
  windowEnd: number
}

export interface BlockBreakResult {
  zones: HlZone[]
  signals: BbSignal[]
  watching: BbWatch[]
  /** Blocks formed and not touched yet (still live). */
  fresh: HlZone[]
  /** Fresh blocks touched without a signal, and why. */
  passed: { zone: HlZone; touchTime: number; why: string }[]
  error: string | null
}

/** Footprint rows the setup was found with (research/block-swing-study.ts). */
const ROW_BY_SYMBOL: Record<string, number> = { XAUTUSD: 0.5, PAXGUSD: 0.5, XAUUSD: 0.5, BTCUSD: 10, ETHUSD: 0.5 }

/** Row height: the researched one for known symbols, else ≈ price / 8000 on the nearest 1-2-5 step. */
export function autoRowSize(price: number, symbol = ''): number {
  const known = ROW_BY_SYMBOL[symbol.toUpperCase().replace(/^.*:/, '')]
  if (known) return known
  const raw = Math.max(price / 8000, 1e-8)
  const p = 10 ** Math.floor(Math.log10(raw))
  const m = raw / p
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p
}

/** Longest run of diagonal imbalances in direction `dir` (1 = buying, -1 = selling) in one bar. */
export function stackedRun(rows: Map<number, [number, number]>, dir: 1 | -1, ratio: number, minShare: number): number {
  const rs = [...rows.entries()].sort((a, b) => a[0] - b[0])
  let vol = 0
  for (const [, [b, s]] of rs) vol += b + s
  const minV = minShare * vol
  let run = 0
  let best = 0
  if (dir === 1) {
    for (let r = 1; r < rs.length; r++) {
      const buy = rs[r][1][0]
      run = buy > 0 && buy >= ratio * rs[r - 1][1][1] && buy >= minV ? run + 1 : 0
      best = Math.max(best, run)
    }
  } else {
    for (let r = 0; r < rs.length - 1; r++) {
      const sell = rs[r][1][1]
      run = sell > 0 && sell >= ratio * rs[r + 1][1][0] && sell >= minV ? run + 1 : 0
      best = Math.max(best, run)
    }
  }
  return best
}

function firstAtOrAfter(bars: BbBar[], t: number): number {
  let lo = 0
  let hi = bars.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (bars[m].time < t) lo = m + 1
    else hi = m
  }
  return lo
}

/** Signals on given blocks (exported for tests; computeBlockBreak finds the blocks too). */
export function detectBlockBreaks(bars: BbBar[], zones: HlZone[], o: BlockBreakOptions): Omit<BlockBreakResult, 'zones' | 'error'> {
  const signals: BbSignal[] = []
  const watching: BbWatch[] = []
  const fresh: HlZone[] = []
  const passed: BlockBreakResult['passed'] = []
  const n = bars.length
  if (!n) return { signals, watching, fresh, passed }
  for (const z of zones) {
    const from = firstAtOrAfter(bars, z.time + 1)
    if (from >= n) {
      if (z.right === null) fresh.push(z)
      continue
    }
    if (from < 1) continue
    const end = z.right ?? Infinity
    let k = -1
    let side: 0 | 1 | -1 = 0
    for (let i = from; i < n && bars[i].time < end; i++) {
      if (bars[i].high < z.bottom || bars[i].low > z.top) continue
      const p = bars[i - 1]
      side = p.low > z.top ? 1 : p.high < z.bottom ? -1 : 0
      k = i
      break
    }
    if (k < 0) {
      if (z.right === null) fresh.push(z)
      continue
    }
    const touchTime = bars[k].time
    if (!side) {
      passed.push({ zone: z, touchTime, why: 'touch started inside the block' })
      continue
    }
    const windowEnd = touchTime + o.windowMin * MIN
    const wEnd = firstAtOrAfter(bars, windowEnd)
    // the window is complete once a bar after it exists (its last minute has closed)
    if (wEnd >= n) {
      watching.push({ zone: z, touchTime, from: side, windowEnd })
      continue
    }
    const win = bars.slice(k, wEnd)
    const close = win[win.length - 1].close
    const dir: 1 | -1 = side === 1 ? -1 : 1
    const accepted = dir === -1 ? close < z.bottom : close > z.top
    let stack = 0
    for (const b of win) stack = Math.max(stack, stackedRun(b.rows, dir, o.imbalance, o.minRowShare))
    if (!accepted) {
      passed.push({ zone: z, touchTime, why: 'window did not close through the block' })
      continue
    }
    if (stack < o.stackRows) {
      passed.push({ zone: z, touchTime, why: `no stacked imbalance in the break direction (${stack} rows)` })
      continue
    }
    const entry = close
    const stop = dir === 1 ? z.bottom - (entry * o.stopBufPct) / 100 : z.top + (entry * o.stopBufPct) / 100
    const risk = dir * (entry - stop)
    if (risk < (entry * o.minStopPct) / 100) {
      passed.push({ zone: z, touchTime, why: 'stop closer than the minimum' })
      continue
    }
    const sig: BbSignal = {
      zone: z, dir, touchTime, entryTime: windowEnd, entry, stop,
      t1: entry + dir * o.t1R * risk, t2: entry + dir * o.t2R * risk, stack,
      t1Time: null, exitTime: null, exitPrice: null, outcome: 'open', r: 0, expiry: windowEnd + o.holdHours * 3_600_000,
    }
    for (let j = wEnd; j < n; j++) {
      const b = bars[j]
      if (dir === 1 ? b.low <= stop : b.high >= stop) { sig.outcome = 'stop'; sig.exitTime = b.time; sig.exitPrice = stop; break }
      if (sig.t1Time === null && (dir === 1 ? b.high >= sig.t1 : b.low <= sig.t1)) sig.t1Time = b.time
      if (dir === 1 ? b.high >= sig.t2 : b.low <= sig.t2) { sig.outcome = 't2'; sig.exitTime = b.time; sig.exitPrice = sig.t2; break }
      if (b.time + MIN >= sig.expiry) { sig.outcome = 'time'; sig.exitTime = b.time; sig.exitPrice = b.close; break }
    }
    sig.r = (dir * ((sig.exitPrice ?? bars[n - 1].close) - entry)) / risk
    signals.push(sig)
  }
  signals.sort((a, b) => a.entryTime - b.entryTime)
  return { signals, watching, fresh, passed }
}

/** Blocks from the 1-minute bars, then the signals on them. */
export function computeBlockBreak(bars: BbBar[], o: BlockBreakOptions = BLOCK_BREAK_DEFAULTS): BlockBreakResult {
  const hb = computeHlBlocks(bars, o.blocks, 60)
  if (hb.error) return { zones: [], signals: [], watching: [], fresh: [], passed: [], error: hb.error }
  return { zones: hb.zones, ...detectBlockBreaks(bars, hb.zones, o), error: null }
}

/** Fold one print into 1-minute bars. Prints should arrive in time order; a late one joins its minute if that bar exists. */
export function addPrintToBars(bars: BbBar[], tMs: number, price: number, qty: number, buy: boolean, row: number): void {
  const t = Math.floor(tMs / MIN) * MIN
  let b = bars[bars.length - 1]
  if (!b || t > b.time) {
    b = { time: t, open: price, high: price, low: price, close: price, volume: 0, buyVolume: 0, rows: new Map() }
    bars.push(b)
  } else if (t < b.time) {
    let i = bars.length - 1
    while (i > 0 && bars[i].time > t) i--
    if (bars[i].time !== t) return
    b = bars[i]
  } else b.close = price
  b.high = Math.max(b.high, price)
  b.low = Math.min(b.low, price)
  b.volume += qty
  if (buy) b.buyVolume = (b.buyVolume ?? 0) + qty
  const r = Math.floor(price / row + 1e-9) * row
  const e = b.rows.get(r) ?? [0, 0]
  e[buy ? 0 : 1] += qty
  b.rows.set(r, e)
}
