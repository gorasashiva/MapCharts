/**
 * Order book rebuilt from incremental updates (DataProvider.subscribeBook),
 * keeping a short memory of each level's peak size.
 *
 * Why the memory: a big taker order that eats a resting level removes it from
 * the book, and the trade print and the book update arrive in either order.
 * Asking "what was resting here just before the trade?" needs the size the
 * level showed a moment ago, not its size now — so each level keeps its peak
 * over PEAK_WINDOW_MS, and emptied levels linger that long before pruning.
 *
 * Totals per price only: a public feed has no individual orders (no MBO), so
 * "a large resting order" here means a large total resting at that price.
 */
import type { BookEvent } from '../data/types'

export const PEAK_WINDOW_MS = 2_000

interface Level {
  size: number
  peak: number
  peakAt: number
}

export type BookSide = 'bid' | 'ask'

export class LevelBook {
  private bids = new Map<number, Level>()
  private asks = new Map<number, Level>()
  private lastPrune = 0
  /** Exchange time of the last applied message (0 = no snapshot yet). */
  time = 0

  apply(e: BookEvent): void {
    if (e.action === 'snapshot') {
      this.bids.clear()
      this.asks.clear()
    } else if (this.time === 0) {
      return // deltas before the first snapshot can't be placed
    }
    this.time = e.time
    for (const [p, q] of e.bids) this.set(this.bids, p, q, e.time)
    for (const [p, q] of e.asks) this.set(this.asks, p, q, e.time)
    if (e.time - this.lastPrune > PEAK_WINDOW_MS) this.prune(e.time)
  }

  /** Size resting at `price` now (0 if none). */
  sizeAt(side: BookSide, price: number): number {
    return this.map(side).get(price)?.size ?? 0
  }

  /** Largest size `price` showed within PEAK_WINDOW_MS of `atMs` — what a trade then ran into. */
  restingBefore(side: BookSide, price: number, atMs: number): number {
    const l = this.map(side).get(price)
    if (!l) return 0
    return Math.abs(atMs - l.peakAt) <= PEAK_WINDOW_MS ? Math.max(l.peak, l.size) : l.size
  }

  clear(): void {
    this.bids.clear()
    this.asks.clear()
    this.time = 0
  }

  private map(side: BookSide): Map<number, Level> {
    return side === 'bid' ? this.bids : this.asks
  }

  private set(m: Map<number, Level>, price: number, size: number, t: number): void {
    const l = m.get(price)
    if (!l) {
      if (size > 0) m.set(price, { size, peak: size, peakAt: t })
      return
    }
    if (t - l.peakAt > PEAK_WINDOW_MS) {
      // Window restarts here; the size the level showed right up to this change still counts.
      l.peak = Math.max(l.size, size)
      l.peakAt = t
    } else if (size >= l.peak) {
      l.peak = size
      l.peakAt = t
    }
    l.size = size
  }

  private prune(now: number): void {
    this.lastPrune = now
    for (const m of [this.bids, this.asks]) {
      for (const [p, l] of m) if (l.size === 0 && now - l.peakAt > PEAK_WINDOW_MS) m.delete(p)
    }
  }
}
