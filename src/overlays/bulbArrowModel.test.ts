import { describe, expect, it } from 'vitest'
import { computeBulbArrow, rsi, swings, type BulbBar } from './bulbArrowModel'

const bar = (c: number, hi = c + 0.5, lo = c - 0.5): BulbBar => ({ high: hi, low: lo, close: c })

describe('bulbArrowModel', () => {
  it('rsi is 100 on a straight rise and 0 on a straight fall', () => {
    const up = rsi([1, 2, 3, 4, 5, 6, 7, 8], 7)
    const dn = rsi([8, 7, 6, 5, 4, 3, 2, 1], 7)
    expect(Number.isNaN(up[6])).toBe(true)
    expect(up[7]).toBe(100)
    expect(dn[7]).toBe(0)
  })

  it('marks one swing high per overbought run, on the run’s highest bar', () => {
    // r: oversold, then overbought for 3 bars (high peaks on the middle one), then oversold
    const r = Float64Array.from([20, 70, 80, 70, 20, 20])
    const bars = [bar(10), bar(11), bar(15, 16), bar(12), bar(8, 9, 5), bar(9)]
    const pts = swings(bars, r, 65, 35)
    expect(pts).toEqual([
      { dir: 1, index: 2, price: 16 },
      { dir: -1, index: 4, price: 5 },
    ])
  })

  it('no marker before the first opposite switch (Pine labels start as na)', () => {
    const r = Float64Array.from([70, 80, 90])
    expect(swings([bar(1), bar(2), bar(3)], r, 65, 35)).toEqual([])
  })

  it('RSI crossing its SMA yields alternating buys and sells', () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + 10 * Math.sin(i / 8))
    const res = computeBulbArrow(closes.map((c) => bar(c)))
    expect(res.buys.length).toBeGreaterThan(2)
    expect(res.sells.length).toBeGreaterThan(2)
    const all = [...res.buys.map((i) => [i, 1]), ...res.sells.map((i) => [i, -1])].sort((a, b) => a[0] - b[0])
    for (let k = 1; k < all.length; k++) expect(all[k][1]).not.toBe(all[k - 1][1])
  })
})
