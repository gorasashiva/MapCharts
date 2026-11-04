import { describe, expect, it } from 'vitest'
import { barStats, coveredBy, divergenceBreakLabels, isDeltaDivergence, mergeSpans } from './footprint'

describe('Footprint — divergence candles', () => {
  it('a bearish candle with positive delta, or a bullish one with negative delta, diverges', () => {
    expect(isDeltaDivergence(100, 99, 50)).toBe(true) // closed down on net buying
    expect(isDeltaDivergence(99, 100, -50)).toBe(true) // closed up on net selling
  })

  it('agreement, zero delta and dojis do not', () => {
    expect(isDeltaDivergence(100, 99, -50)).toBe(false)
    expect(isDeltaDivergence(99, 100, 50)).toBe(false)
    expect(isDeltaDivergence(100, 99, 0)).toBe(false)
    expect(isDeltaDivergence(100, 100, 50)).toBe(false)
  })
})

describe('Footprint — which bars are exact', () => {
  it('joins recorded spans across tiny seams, but not across real gaps', () => {
    // 0.5s seam joined; 3s gap kept
    expect(mergeSpans([[7000, 9000], [0, 4000], [9500, 12_000]])).toEqual([[0, 4000], [7000, 12_000]])
  })

  it('a bar is exact only if one continuous span covers all of it', () => {
    const spans = mergeSpans([[0, 300_000], [300_500, 600_000], [900_000, Infinity]])
    expect(coveredBy(spans, 0, 300_000)).toBe(true)
    expect(coveredBy(spans, 300_000, 600_000)).toBe(true) // the 0.5s seam is joined
    expect(coveredBy(spans, 600_000, 900_000)).toBe(false) // recorder was down: estimated
    expect(coveredBy(spans, 900_000, 1_000_000)).toBe(true) // live from here on
  })
})

describe('Footprint — per-bar stats', () => {
  it('finds range, POC and grows the value area toward heavier rows', () => {
    // row -> [buy, sell]; total 100, POC row 2 (40)
    const rows = new Map<number, [number, number]>([
      [0, [5, 0]], [1, [10, 15]], [2, [30, 10]], [3, [10, 5]], [4, [0, 15]],
    ])
    const s = barStats(rows, 0.7)
    expect([s.rLo, s.rHi, s.tot, s.delta, s.pocRow, s.maxVol]).toEqual([0, 4, 100, 10, 2, 40])
    // 40 + row1 (25) = 65, then row3 (15) vs row0 (5): up wins -> 80 >= 70
    expect([s.vaLo, s.vaHi]).toEqual([1, 3])
  })
})

describe('divergenceBreakLabels', () => {
  const k = (o: number, h: number, l: number, c: number) => ({ open: o, high: h, low: l, close: c })
  it('SELL when the next candle closes below a bearish candle with positive delta; BUY mirrored', () => {
    const bars = [
      k(105, 106, 100, 101), // bearish, delta +5 → trigger
      k(101, 102, 98, 99), // closes 99 < 100 → SELL here
      k(99, 104, 98, 103), // bullish, delta −4 → trigger
      k(103, 106, 102, 105), // closes 105 > 104 → BUY here
    ]
    const delta = [5, 0, -4, 0]
    expect(divergenceBreakLabels(bars, (i) => delta[i])).toEqual([
      { index: 1, side: -1, trigger: 0 },
      { index: 3, side: 1, trigger: 2 },
    ])
  })

  it('needs the very next candle, a real divergence and exact data', () => {
    const bars = [k(105, 106, 100, 101), k(101, 102, 100.5, 101), k(101, 101, 97, 98)]
    // the break comes two candles later: no label
    expect(divergenceBreakLabels(bars, () => 5)).toEqual([])
    // negative delta on a bearish candle is no divergence
    expect(divergenceBreakLabels([k(105, 106, 100, 101), k(101, 102, 98, 99)], () => -5)).toEqual([])
    // no exact trades on the trigger: no label
    expect(divergenceBreakLabels([k(105, 106, 100, 101), k(101, 102, 98, 99)], () => null)).toEqual([])
  })

  it('alternates: a repeated side is not shown again until the other side prints', () => {
    const sell = [k(105, 106, 100, 101), k(101, 102, 98, 99)]
    const buy = [k(99, 104, 98, 103), k(103, 106, 102, 105)]
    const bars = [...sell, ...sell, ...buy, ...buy, ...sell]
    const delta = (i: number) => [5, 0, 5, 0, -4, 0, -4, 0, 5, 0][i]
    expect(divergenceBreakLabels(bars, delta).map((l) => [l.index, l.side])).toEqual([[1, -1], [5, 1], [9, -1]])
    // and it does not depend on where the history starts
    const later = divergenceBreakLabels(bars.slice(2), (i) => delta(i + 2)).map((l) => [l.index + 2, l.side])
    expect(later.slice(1)).toEqual([[5, 1], [9, -1]])
  })

  it('a label is decided on closed bars only', () => {
    const bars = [k(105, 106, 100, 101), k(101, 102, 98, 99)]
    expect(divergenceBreakLabels(bars, () => 5, 1)).toEqual([]) // the confirming candle is still forming
  })
})
