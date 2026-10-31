import { describe, expect, it } from 'vitest'
import { AGG_GAP_MS, buildClusters, ClusterBuilder, perDayThreshold, type TapePrint } from './takerOrders'

const T0 = 1_791_558_109_000_000 // µs

const p = (dtUs: number, price: number, qty: number, side: 'buy' | 'sell' = 'buy'): TapePrint => ({ tUs: T0 + dtUs, price, qty, side })

describe('taker-order reconstruction', () => {
  // Shape of a real Delta XAUTUSD sweep: one buy ate 4182.78 then 4182.79, three prints ~4–5 ms apart.
  const sweep = [p(0, 4182.78, 10.919), p(4_560, 4182.79, 0.5), p(8_984, 4182.79, 12.783)]

  it('merges a sweep through rising asks into one order', () => {
    const [o, ...rest] = buildClusters(sweep, 'order')
    expect(rest).toHaveLength(0)
    expect(o.qty).toBeCloseTo(24.202)
    expect(o.prints).toBe(3)
    expect(o.orders).toBe(1)
    expect(o.levels[0]).toEqual([4182.78, 10.919])
    expect(o.levels[1][0]).toBe(4182.79)
    expect(o.levels[1][1]).toBeCloseTo(13.283)
  })

  it('splits when the price moves against the aggressor', () => {
    const out = buildClusters([p(0, 100.2, 1), p(2_000, 100.1, 1)], 'order')
    expect(out).toHaveLength(2)
  })

  it('splits on side change and on a gap longer than the sweep window', () => {
    expect(buildClusters([p(0, 100, 1), p(1_000, 100, 1, 'sell')], 'order')).toHaveLength(2)
    expect(buildClusters([p(0, 100, 1), p(40_000, 100, 1)], 'order')).toHaveLength(2)
  })

  it("'separate' keeps every print", () => {
    expect(buildClusters(sweep, 'separate')).toHaveLength(3)
  })
})

describe('cumulative clusters', () => {
  it('merges separate taker orders at the same price within the window', () => {
    const prints = [p(0, 100, 2), p(100_000, 100, 3), p(200_000, 100.01, 1)] // 0, 100, 200 ms apart
    const [c, ...rest] = buildClusters(prints, 'cumulative')
    expect(rest).toHaveLength(0)
    expect(c.orders).toBe(3)
    expect(c.qty).toBe(6)
    expect(c.maxOrder).toBe(3)
  })

  it('starts a new cluster after the window', () => {
    const out = buildClusters([p(0, 100, 2), p((AGG_GAP_MS + 50) * 1000, 100, 3)], 'cumulative')
    expect(out.map((c) => c.qty)).toEqual([2, 3])
  })

  it('live flush waits for a quiet spell, then closes what is open', () => {
    const b = new ClusterBuilder('cumulative')
    expect(b.push(p(0, 100, 2), 1_000)).toEqual([])
    expect(b.flush(1_000 + AGG_GAP_MS)).toEqual([]) // still inside the window
    const done = b.flush(1_000 + AGG_GAP_MS * 3)
    expect(done).toHaveLength(1)
    expect(done[0].qty).toBe(2)
  })
})

describe('perDayThreshold', () => {
  it('lets through about perDay clusters a day', () => {
    const sizes = Array.from({ length: 100 }, (_, i) => i + 1) // 1..100
    expect(perDayThreshold(sizes, 2, 10)).toBe(81) // 20 largest: 81..100
  })

  it('is Infinity with nothing recorded', () => {
    expect(perDayThreshold([], 1, 10)).toBe(Infinity)
    expect(perDayThreshold([5], 0, 10)).toBe(Infinity)
  })
})
