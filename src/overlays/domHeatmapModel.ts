import type { BookTapeRecord } from './bookTape'

// DOM liquidity heatmap — resting limit orders as price × time cells, in the spirit of
// DeepCharts' DeepDOM heatmap: each column is a slice of time, each row a price band, and a
// cell's value is the resting size (USD) that stood there on average over that slice.
// Bids (buy limits, below mid) and asks (sell limits, above mid) are kept apart so the chart
// can colour them differently. Pure maths; the sampler that feeds it lives in domHeatmap.ts.

/** One book snapshot: levels as [price, quantity in base units], bids descending, asks ascending. */
export interface BookSnap {
  t: number
  bids: [number, number][]
  asks: [number, number][]
}

export interface HeatCell {
  col: number
  row: number
  /** true = resting buy limit (bid), false = resting sell limit (ask). */
  bid: boolean
  /** Mean resting size over the column, in USD. */
  value: number
}

export interface HeatGrid {
  /** Start time (ms) of column 0. */
  t0: number
  colMs: number
  cols: number
  /** Lowest price covered, and the height of one row. */
  lo: number
  step: number
  rows: number
  cells: HeatCell[]
  /** 95th-percentile cell value — full intensity. */
  scale: number
}

export interface HeatGridOptions {
  now: number
  historyMs: number
  colMs: number
  mid: number
  /** Price band as a fraction of mid, each side (0.015 = ±1.5%). */
  rangePct: number
  rows: number
  /** Ignore resting orders smaller than this many USD. */
  minUsd: number
}

export function buildHeatGrid(snaps: BookSnap[], o: HeatGridOptions): HeatGrid {
  const t0 = o.now - o.historyMs
  const cols = Math.max(1, Math.ceil(o.historyMs / o.colMs))
  const rows = Math.max(1, Math.round(o.rows))
  const lo = o.mid * (1 - o.rangePct)
  const hi = o.mid * (1 + o.rangePct)
  const step = (hi - lo) / rows
  const colSnaps = new Array<number>(cols).fill(0)
  const sums = new Map<string, { col: number; row: number; bid: boolean; sum: number }>()

  const add = (col: number, row: number, bid: boolean, usd: number): void => {
    const key = `${col}|${row}|${bid ? 1 : 0}`
    const cell = sums.get(key)
    if (cell) cell.sum += usd
    else sums.set(key, { col, row, bid, sum: usd })
  }

  for (const s of snaps) {
    if (s.t < t0 || s.t > o.now) continue
    const col = Math.min(cols - 1, Math.floor((s.t - t0) / o.colMs))
    colSnaps[col]++
    for (const [p, q] of s.bids) {
      if (p < lo || p >= hi) continue
      const usd = p * q
      if (usd >= o.minUsd) add(col, Math.min(rows - 1, Math.floor((p - lo) / step)), true, usd)
    }
    for (const [p, q] of s.asks) {
      if (p < lo || p >= hi) continue
      const usd = p * q
      if (usd >= o.minUsd) add(col, Math.min(rows - 1, Math.floor((p - lo) / step)), false, usd)
    }
  }

  const cells: HeatCell[] = []
  for (const c of sums.values()) {
    const n = colSnaps[c.col]
    if (n === 0) continue
    cells.push({ col: c.col, row: c.row, bid: c.bid, value: c.sum / n })
  }
  const sorted = cells.map((c) => c.value).sort((a, b) => a - b)
  const scale = sorted.length ? Math.max(1, sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1]) : 1
  return { t0, colMs: o.colMs, cols, lo, step, rows, cells, scale }
}

/**
 * Rebuilds the book from recorded tape records (snapshots reset it, updates set each level,
 * qty 0 removes it; a gap drops it until the next snapshot) and emits a snapshot every
 * `sampleMs` of receive time inside [from, to]. Only levels within `bandPct` of the mid are
 * kept, so a day of tape stays small. Mid is taken from the best bid and ask at that moment.
 */
export function replayBookSnaps(records: Iterable<BookTapeRecord>, o: { from: number; to: number; sampleMs: number; bandPct: number }): BookSnap[] {
  const bids = new Map<number, number>()
  const asks = new Map<number, number>()
  const out: BookSnap[] = []
  let valid = false
  let lastSample = Number.NEGATIVE_INFINITY
  for (const r of records) {
    if (r.kind === 'gap') {
      valid = false
      bids.clear()
      asks.clear()
      continue
    }
    if (r.kind !== 'book') continue
    if (r.action === 'snapshot') {
      bids.clear()
      asks.clear()
      valid = true
    } else if (!valid) continue
    for (const [p, q] of r.bids) (q > 0 ? bids.set(p, q) : bids.delete(p))
    for (const [p, q] of r.asks) (q > 0 ? asks.set(p, q) : asks.delete(p))
    if (r.recvMs < o.from || r.recvMs > o.to) continue
    if (r.recvMs - lastSample < o.sampleMs) continue
    let bestBid = Number.NEGATIVE_INFINITY
    let bestAsk = Number.POSITIVE_INFINITY
    for (const p of bids.keys()) if (p > bestBid) bestBid = p
    for (const p of asks.keys()) if (p < bestAsk) bestAsk = p
    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) continue
    lastSample = r.recvMs
    const mid = (bestBid + bestAsk) / 2
    const lo = mid * (1 - o.bandPct)
    const hi = mid * (1 + o.bandPct)
    const keepBids: [number, number][] = []
    const keepAsks: [number, number][] = []
    for (const [p, q] of bids) if (p >= lo && p <= hi) keepBids.push([p, q])
    for (const [p, q] of asks) if (p >= lo && p <= hi) keepAsks.push([p, q])
    keepBids.sort((a, b) => b[0] - a[0])
    keepAsks.sort((a, b) => a[0] - b[0])
    out.push({ t: r.recvMs, bids: keepBids, asks: keepAsks })
  }
  return out
}
