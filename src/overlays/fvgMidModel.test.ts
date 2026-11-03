import { describe, expect, it } from 'vitest'
import { computeFvgMid, type FvgBar } from './fvgMidModel'

const bar = (low: number, high: number): FvgBar => ({ low, high })

describe('fvgMidModel', () => {
  it('finds a bullish gap and its midpoint', () => {
    // high[0] = 101, low[2] = 103 → midpoint 102
    const r = computeFvgMid([bar(100, 101), bar(101, 104), bar(103, 105)])
    expect(r.active).toEqual([{ index: 2, price: 102, side: 1, mitigatedAt: null, droppedAt: null }])
  })

  it('finds a bearish gap and its midpoint', () => {
    // low[0] = 104, high[2] = 102 → midpoint 103
    const r = computeFvgMid([bar(104, 106), bar(101, 105), bar(100, 102)])
    expect(r.active.map((m) => [m.side, m.price])).toEqual([[-1, 103]])
  })

  it('removes a midpoint on the first bar that trades through it', () => {
    const bars = [bar(100, 101), bar(101, 104), bar(103, 105), bar(104, 106), bar(101.5, 104)]
    const r = computeFvgMid(bars)
    expect(r.active).toEqual([])
    expect(r.all[0].mitigatedAt).toBe(4)
    // with mitigation off it stays
    expect(computeFvgMid(bars, { removeOnMitigation: false }).active).toHaveLength(1)
  })

  it('keeps at most maxLines per side, dropping the oldest', () => {
    // a staircase of bullish gaps, each midpoint untouched
    const bars: FvgBar[] = []
    for (let i = 0; i < 8; i++) bars.push(bar(100 + i * 10, 104 + i * 10))
    const r = computeFvgMid(bars, { maxLines: 3 })
    expect(r.active.map((m) => m.index)).toEqual([5, 6, 7])
    expect(r.all.filter((m) => m.droppedAt !== null).map((m) => m.index)).toEqual([2, 3, 4])
  })

  it('respects the side toggles', () => {
    const bars = [bar(100, 101), bar(101, 104), bar(103, 105)]
    expect(computeFvgMid(bars, { bullish: false }).active).toEqual([])
  })
})
