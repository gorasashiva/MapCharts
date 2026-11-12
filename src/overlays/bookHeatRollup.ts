// Book heatmap rollups — the recorded order book summarised per minute at fixed price bins, so the
// DOM Heatmap can show days of history without re-reading raw book files. Pure: the recorder
// (recorder/heatRollup.ts) reads the files and feeds these functions.
//
// Bins are absolute prices (bin k covers [k·step, (k+1)·step)), so the picture stays put as price moves.
// Each minute keeps, per bin, the mean resting USD on the bid side and on the ask side over that minute's
// book snapshots (a bin with nothing resting is simply absent).

import type { BookTapeRecord } from './bookTape'
import type { BookSnap, HeatGrid } from './domHeatmapModel'

export const MINUTE_MS = 60_000
/** Half-width of the band kept per snapshot when rolling up (±2% of mid). */
export const ROLLUP_BAND_PCT = 0.02

/** Price bin size per market, in price units: about 0.03% of a typical price, so a bin is a few ticks wide. */
export function binStepFor(symbol: string): number {
  const s = symbol.toUpperCase()
  if (s.startsWith('BTC')) return 25
  if (s.startsWith('ETH')) return 1
  return 1 // XAUT / gold
}

/** Rebuilds the book from recorded records and emits a snapshot at most every `sampleMs` inside [from, to]. */
export class BookReplayer {
  private bids = new Map<number, number>()
  private asks = new Map<number, number>()
  private valid = false
  private lastSample = Number.NEGATIVE_INFINITY

  private readonly o: { from: number; to: number; sampleMs: number; bandPct: number }

  constructor(o: { from: number; to: number; sampleMs: number; bandPct: number }) {
    this.o = o
  }

  feed(r: BookTapeRecord): BookSnap | null {
    if (r.kind === 'gap') {
      this.valid = false
      this.bids.clear()
      this.asks.clear()
      return null
    }
    if (r.kind !== 'book') return null
    if (r.action === 'snapshot') {
      this.bids.clear()
      this.asks.clear()
      this.valid = true
    } else if (!this.valid) return null
    for (const [p, q] of r.bids) (q > 0 ? this.bids.set(p, q) : this.bids.delete(p))
    for (const [p, q] of r.asks) (q > 0 ? this.asks.set(p, q) : this.asks.delete(p))
    if (r.recvMs < this.o.from || r.recvMs > this.o.to) return null
    if (r.recvMs - this.lastSample < this.o.sampleMs) return null
    let bestBid = Number.NEGATIVE_INFINITY
    let bestAsk = Number.POSITIVE_INFINITY
    for (const p of this.bids.keys()) if (p > bestBid) bestBid = p
    for (const p of this.asks.keys()) if (p < bestAsk) bestAsk = p
    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return null
    this.lastSample = r.recvMs
    const mid = (bestBid + bestAsk) / 2
    const lo = mid * (1 - this.o.bandPct)
    const hi = mid * (1 + this.o.bandPct)
    const bids: [number, number][] = []
    const asks: [number, number][] = []
    for (const [p, q] of this.bids) if (p >= lo && p <= hi) bids.push([p, q])
    for (const [p, q] of this.asks) if (p >= lo && p <= hi) asks.push([p, q])
    bids.sort((a, b) => b[0] - a[0])
    asks.sort((a, b) => a[0] - b[0])
    return { t: r.recvMs, bids, asks }
  }
}

/** One minute: `bins` holds [bin index, mean bid USD, mean ask USD]. `mid` is the mean mid of its snapshots. */
export interface MinuteRow {
  m: number
  step: number
  mid: number
  /** Mean best bid and best ask over the minute's snapshots. */
  bb: number
  ba: number
  bins: [number, number, number][]
  /** Trades in the minute, by price bin: [bin index, buy USD, sell USD, count]. */
  tr: [number, number, number, number][]
}

/** Groups snapshots into minutes and averages each bin over the minute's snapshots. */
export class MinuteAccumulator {
  private cur: { m: number; n: number; midSum: number; midN: number; bidSum: number; askSum: number; bins: Map<number, [number, number]> } | null = null
  /** Trades by minute and price bin: [buy USD, sell USD, count]. Kept until their minute is written. */
  private trades = new Map<number, Map<number, [number, number, number]>>()
  private lastEmitted = Number.NEGATIVE_INFINITY

  private readonly step: number

  constructor(step: number) {
    this.step = step
  }

  /** Adds one snapshot; returns the minutes it completed (usually none). */
  add(s: BookSnap): MinuteRow[] {
    const m = Math.floor(s.t / MINUTE_MS) * MINUTE_MS
    const done: MinuteRow[] = []
    if (this.cur && m !== this.cur.m) {
      const row = this.flush()
      if (row) done.push(row)
    }
    if (!this.cur) this.cur = { m, n: 0, midSum: 0, midN: 0, bidSum: 0, askSum: 0, bins: new Map() }
    const c = this.cur
    c.n++
    const bb = s.bids[0]?.[0]
    const ba = s.asks[0]?.[0]
    if (bb > 0 && ba > 0) {
      c.midSum += (bb + ba) / 2
      c.midN++
      c.bidSum += bb
      c.askSum += ba
    }
    for (const [p, q] of s.bids) this.put(c.bins, p, q, 0)
    for (const [p, q] of s.asks) this.put(c.bins, p, q, 1)
    return done
  }

  /** Adds one trade to its minute and bin. Trades carry their own time, so they may come before that minute's book. */
  addTrade(t: { recvMs: number; price: number; qty: number; buy: boolean }): void {
    const m = Math.floor(t.recvMs / MINUTE_MS) * MINUTE_MS
    if (m <= this.lastEmitted) return // that minute is already written
    const byBin = this.trades.get(m) ?? new Map<number, [number, number, number]>()
    this.trades.set(m, byBin)
    const k = Math.floor(t.price / this.step)
    const e = byBin.get(k) ?? [0, 0, 0]
    if (t.buy) e[0] += t.price * t.qty
    else e[1] += t.price * t.qty
    e[2]++
    byBin.set(k, e)
  }

  private put(bins: Map<number, [number, number]>, price: number, qty: number, side: 0 | 1): void {
    const k = Math.floor(price / this.step)
    const e = bins.get(k) ?? [0, 0]
    e[side] += price * qty
    bins.set(k, e)
  }

  /** Closes the current minute (if any) and returns it. */
  flush(): MinuteRow | null {
    const c = this.cur
    this.cur = null
    if (!c || c.n === 0 || c.midN === 0) return null
    const bins: [number, number, number][] = []
    for (const [k, [b, a]] of c.bins) bins.push([k, b / c.n, a / c.n])
    bins.sort((x, y) => x[0] - y[0])
    const tr: [number, number, number, number][] = []
    const byBin = this.trades.get(c.m)
    if (byBin) for (const [k, [b, a, n]] of byBin) tr.push([k, b, a, n])
    for (const key of [...this.trades.keys()]) if (key <= c.m) this.trades.delete(key)
    this.lastEmitted = c.m
    return { m: c.m, step: this.step, mid: c.midSum / c.midN, bb: c.bidSum / c.n, ba: c.askSum / c.n, bins, tr }
  }
}

export interface RollupGridOptions {
  from: number
  to: number
  /** Width of one time column (ms). */
  colMs: number
  /** Most price rows to draw; finer bins are merged when the window spans more. */
  maxRows: number
  /** Ignore bins smaller than this many USD per minute. */
  minUsd: number
}

/** Bins minute rows into the time × price grid the DOM Heatmap draws (absolute prices). */
export function heatGridFromRows(data: MinuteRow[], o: RollupGridOptions): HeatGrid & { mid: number | null; minutes: number } {
  const cols = Math.max(1, Math.ceil((o.to - o.from) / o.colMs))
  const inWindow = data.filter((r) => r.m >= o.from && r.m < o.to)
  if (inWindow.length === 0) return { t0: o.from, colMs: o.colMs, cols, lo: 0, step: 1, rows: 1, cells: [], scale: 1, mid: null, minutes: 0 }
  const step = inWindow[0].step
  const colMinutes = new Array<number>(cols).fill(0)
  const sums = new Map<number, Map<number, [number, number]>>() // col -> bin -> [bid, ask]
  let kMin = Number.POSITIVE_INFINITY
  let kMax = Number.NEGATIVE_INFINITY
  let mid: number | null = null
  for (const r of inWindow) {
    const col = Math.min(cols - 1, Math.floor((r.m - o.from) / o.colMs))
    colMinutes[col]++
    mid = r.mid
    const colMap = sums.get(col) ?? new Map<number, [number, number]>()
    sums.set(col, colMap)
    for (const [k, b, a] of r.bins) {
      if (b + a < o.minUsd) continue
      const e = colMap.get(k) ?? [0, 0]
      e[0] += b
      e[1] += a
      colMap.set(k, e)
      if (k < kMin) kMin = k
      if (k > kMax) kMax = k
    }
  }
  if (!Number.isFinite(kMin)) return { t0: o.from, colMs: o.colMs, cols, lo: 0, step, rows: 1, cells: [], scale: 1, mid, minutes: inWindow.length }
  const span = kMax - kMin + 1
  const f = Math.max(1, Math.ceil(span / Math.max(1, o.maxRows)))
  const rows = Math.ceil(span / f)
  const cellMap = new Map<string, { col: number; row: number; bid: boolean; sum: number }>()
  for (const [col, colMap] of sums) {
    const n = Math.max(1, colMinutes[col])
    for (const [k, [b, a]] of colMap) {
      const row = Math.floor((k - kMin) / f)
      for (const [side, v] of [
        [1, b],
        [0, a],
      ] as const) {
        if (v <= 0) continue
        const key = `${col}|${row}|${side}`
        const cell = cellMap.get(key)
        if (cell) cell.sum += v / n
        else cellMap.set(key, { col, row, bid: side === 1, sum: v / n })
      }
    }
  }
  const cells = [...cellMap.values()].map((c) => ({ col: c.col, row: c.row, bid: c.bid, value: c.sum }))
  const sorted = cells.map((c) => c.value).sort((x, y) => x - y)
  const scale = sorted.length ? Math.max(1, sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1]) : 1
  return { t0: o.from, colMs: o.colMs, cols, lo: kMin * step, step: step * f, rows, cells, scale, mid, minutes: inWindow.length }
}

/** A trade bubble: USD bought and sold in one column × row of the grid. */
export interface GridTrade {
  col: number
  row: number
  buy: number
  sell: number
  n: number
}

/** Best bid and ask for one column (mean over its minutes). */
export interface GridBbo {
  col: number
  bid: number
  ask: number
}

/**
 * Trades and best bid / ask on the same grid as heatGridFromRows (`grid` is its result, with the same
 * column width and price rows). Only minutes inside [from, to) count.
 */
export function tradesAndBboFromRows(
  data: MinuteRow[],
  grid: { t0: number; colMs: number; cols: number; lo: number; step: number; rows: number },
  o: { from: number; to: number },
): { trades: GridTrade[]; bbo: GridBbo[] } {
  const base = data.find((r) => r.m >= o.from && r.m < o.to)?.step
  if (!base) return { trades: [], bbo: [] }
  const kMin = Math.round(grid.lo / base)
  const f = Math.max(1, Math.round(grid.step / base))
  const tradeMap = new Map<string, GridTrade>()
  const bboSum = new Map<number, { bid: number; ask: number; n: number }>()
  for (const r of data) {
    if (r.m < o.from || r.m >= o.to) continue
    const col = Math.min(grid.cols - 1, Math.max(0, Math.floor((r.m - grid.t0) / grid.colMs)))
    const b = bboSum.get(col) ?? { bid: 0, ask: 0, n: 0 }
    b.bid += r.bb ?? 0
    b.ask += r.ba ?? 0
    b.n++
    bboSum.set(col, b)
    for (const [k, buy, sell, n] of r.tr ?? []) {
      const row = Math.floor((k - kMin) / f)
      if (row < 0 || row >= grid.rows) continue
      const key = `${col}|${row}`
      const t = tradeMap.get(key) ?? { col, row, buy: 0, sell: 0, n: 0 }
      t.buy += buy
      t.sell += sell
      t.n += n
      tradeMap.set(key, t)
    }
  }
  const bbo = [...bboSum.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([col, s]) => ({ col, bid: s.bid / s.n, ask: s.ask / s.n }))
  return { trades: [...tradeMap.values()], bbo }
}

/**
 * Groups price rows that sit within `gap` rows of each other into one zone, e.g. [4,5,6,9] → [[4,5,6],[9]]
 * with gap 2 → [[4,5,6,9]]. Input rows may be in any order; output groups are ascending.
 */
export function mergeRows(rows: number[], gap = 2): number[][] {
  const sorted = [...new Set(rows)].sort((a, b) => a - b)
  const groups: number[][] = []
  for (const r of sorted) {
    const last = groups[groups.length - 1]
    if (last && r - last[last.length - 1] <= gap) last.push(r)
    else groups.push([r])
  }
  return groups
}

/**
 * How price reacted to a zone [lo, hi]: each time the mid enters the zone (a touch), the reaction is the
 * first later minute, within `windowMin`, where the mid is `reactPct` of price beyond either edge.
 */
export function zoneReactions(rows: MinuteRow[], lo: number, hi: number, o: { reactPct: number; windowMin: number }): { touches: number; reactions: number; reactMs: number[] } {
  let touches = 0
  let reactions = 0
  const reactMs: number[] = []
  let wasIn = false
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const inside = r.mid >= lo && r.mid <= hi
    if (inside && !wasIn) {
      touches++
      const dist = r.mid * o.reactPct
      for (let j = i + 1; j < rows.length && rows[j].m - r.m <= o.windowMin * MINUTE_MS; j++) {
        const p = rows[j].mid
        if (p > hi + dist || p < lo - dist) {
          reactions++
          reactMs.push(rows[j].m)
          break
        }
      }
    }
    wasIn = inside
  }
  return { touches, reactions, reactMs }
}
