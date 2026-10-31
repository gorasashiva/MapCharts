/**
 * Taker-order reconstruction and big-trade clustering from a raw trade tape.
 *
 * Shared by the browser (live Big Trades / Deep Trades) and the Node tape
 * recorder (recorder/tapeRecorder.mjs, which imports this file directly), so
 * it must stay dependency-free and use only erasable TypeScript syntax.
 *
 * Two stages:
 *
 *   1. Taker order. A public tape has no order ids, but one aggressive order
 *      shows up as a burst of prints: same side, a few ms apart (Delta stamps
 *      each fill separately — a sweep from 4182.78 into 4182.79 arrived as
 *      three prints ~4–5 ms apart), with price only moving in the aggressor's
 *      direction (a buy sweeps up the asks, a sell down the bids). Prints that
 *      fit that pattern are merged into one order.
 *   2. Cluster (DeepCharts' "Aggregate Trades" input). Consecutive taker
 *      orders on the same side at (near) the same price within a short window
 *      are one worked position — merged into one bubble.
 *
 * Modes: 'separate' = every print is its own cluster; 'order' = stage 1 only;
 * 'cumulative' = both stages (DeepCharts' Aggregate input).
 */

export type TapeSide = 'buy' | 'sell'

export interface TapePrint {
  /** Exchange timestamp in microseconds (Delta's native resolution). */
  tUs: number
  price: number
  /** Base-asset quantity. */
  qty: number
  /** Taker (aggressor) side. */
  side: TapeSide
}

export interface TradeCluster {
  /** First print, epoch ms. */
  time: number
  /** Last print, epoch ms. */
  lastTime: number
  /** Volume-weighted average price. */
  price: number
  side: TapeSide
  qty: number
  /** Taker orders merged into this cluster. */
  orders: number
  /** Largest single taker order inside it. */
  maxOrder: number
  prints: number
  /** Volume per price level touched, [price, qty]. */
  levels: [number, number][]
}

export type ClusterMode = 'separate' | 'order' | 'cumulative'

/** Max gap between two prints of one taker order. */
export const SWEEP_GAP_US = 15_000
/** Max gap between taker orders merged into one cluster (cumulative mode). */
export const AGG_GAP_MS = 250
/** Max relative price distance between taker orders merged into one cluster. */
export const AGG_PRICE_TOLERANCE = 0.0005

/** DeepCharts' auto filter aims for ~10 big trades a day; Low / Strong loosen / tighten that. */
export const INTENSITY_PER_DAY = { low: 20, medium: 10, strong: 5 } as const
export type TapeIntensity = keyof typeof INTENSITY_PER_DAY

interface OpenOrder {
  firstUs: number
  lastUs: number
  lastPrice: number
  side: TapeSide
  qty: number
  notional: number
  prints: number
  levels: Map<number, number>
}

function openOrder(p: TapePrint): OpenOrder {
  return { firstUs: p.tUs, lastUs: p.tUs, lastPrice: p.price, side: p.side, qty: p.qty, notional: p.qty * p.price, prints: 1, levels: new Map([[p.price, p.qty]]) }
}

function orderToCluster(o: OpenOrder): TradeCluster {
  return {
    time: Math.floor(o.firstUs / 1000),
    lastTime: Math.floor(o.lastUs / 1000),
    price: o.notional / o.qty,
    side: o.side,
    qty: o.qty,
    orders: 1,
    maxOrder: o.qty,
    prints: o.prints,
    levels: [...o.levels],
  }
}

function mergeInto(c: TradeCluster, o: TradeCluster): void {
  const qty = c.qty + o.qty
  c.price = (c.price * c.qty + o.price * o.qty) / qty
  c.qty = qty
  c.lastTime = o.lastTime
  c.orders += o.orders
  c.maxOrder = Math.max(c.maxOrder, o.maxOrder)
  c.prints += o.prints
  const lv = new Map(c.levels)
  for (const [p, q] of o.levels) lv.set(p, (lv.get(p) ?? 0) + q)
  c.levels = [...lv]
}

/**
 * Incremental builder: push prints in tape order, get back the clusters each
 * print completed. Live callers also call flush(wallMs) on a timer so a
 * cluster closes after a quiet spell; batch callers call flush() at the end.
 */
export class ClusterBuilder {
  private readonly mode: ClusterMode
  private order: OpenOrder | null = null
  private cluster: TradeCluster | null = null
  private lastPushWall = 0

  constructor(mode: ClusterMode) {
    this.mode = mode
  }

  /** `wallMs` = local clock at arrival; only flush(wallMs) uses it. */
  push(p: TapePrint, wallMs = 0): TradeCluster[] {
    this.lastPushWall = wallMs
    if (!(p.qty > 0) || !(p.price > 0)) return []
    if (this.mode === 'separate') return [orderToCluster(openOrder(p))]
    const out: TradeCluster[] = []
    const o = this.order
    const continues =
      o !== null &&
      o.side === p.side &&
      p.tUs - o.lastUs <= SWEEP_GAP_US &&
      (p.side === 'buy' ? p.price >= o.lastPrice : p.price <= o.lastPrice)
    if (o && continues) {
      o.lastUs = p.tUs
      o.lastPrice = p.price
      o.qty += p.qty
      o.notional += p.qty * p.price
      o.prints++
      o.levels.set(p.price, (o.levels.get(p.price) ?? 0) + p.qty)
      return out
    }
    if (o) this.closeOrder(o, out)
    this.order = openOrder(p)
    return out
  }

  /** Close everything (no argument), or — live — only once nothing has arrived for longer than the cluster window. */
  flush(wallMs?: number): TradeCluster[] {
    if (wallMs !== undefined && wallMs - this.lastPushWall <= AGG_GAP_MS * 2) return []
    const out: TradeCluster[] = []
    if (this.order) this.closeOrder(this.order, out)
    if (this.cluster) out.push(this.cluster)
    this.cluster = null
    return out
  }

  private closeOrder(o: OpenOrder, out: TradeCluster[]): void {
    this.order = null
    const oc = orderToCluster(o)
    if (this.mode === 'order') {
      out.push(oc)
      return
    }
    const c = this.cluster
    if (c && c.side === oc.side && oc.time - c.lastTime <= AGG_GAP_MS && Math.abs(oc.price - c.price) / c.price < AGG_PRICE_TOLERANCE) {
      mergeInto(c, oc)
      return
    }
    if (c) out.push(c)
    this.cluster = oc
  }
}

/** Batch: every cluster in a tape (prints in time order). */
export function buildClusters(prints: Iterable<TapePrint>, mode: ClusterMode): TradeCluster[] {
  const b = new ClusterBuilder(mode)
  const out: TradeCluster[] = []
  for (const p of prints) for (const c of b.push(p)) out.push(c)
  for (const c of b.flush()) out.push(c)
  return out
}

/**
 * DeepCharts-style auto filter: the size that lets through about `perDay`
 * clusters a day over `days` days of tape. Computed once from history, not
 * updated live (DeepCharts documents the same behaviour).
 */
export function perDayThreshold(sizes: number[], days: number, perDay: number): number {
  if (sizes.length === 0 || !(days > 0)) return Infinity
  const sorted = [...sizes].sort((a, b) => b - a)
  const k = Math.max(1, Math.min(sorted.length, Math.round(perDay * days)))
  return sorted[k - 1]
}
