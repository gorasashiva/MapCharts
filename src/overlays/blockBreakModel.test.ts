import { describe, expect, it } from 'vitest'
import { BLOCK_BREAK_DEFAULTS, addPrintToBars, autoRowSize, detectBlockBreaks, stackedRun, type BbBar } from './blockBreakModel'
import type { HlZone } from './hlBlocksModel'

const MIN = 60_000
const T0 = Date.UTC(2026, 10, 2, 10, 0)

function bar(i: number, o: number, h: number, l: number, c: number, rows: [number, number, number][] = []): BbBar {
  return { time: T0 + i * MIN, open: o, high: h, low: l, close: c, volume: rows.reduce((s, r) => s + r[1] + r[2], 0) || 1, rows: new Map(rows.map(([p, b, s]) => [p, [b, s] as [number, number]])) }
}
// a low block [100, 101] formed at bar 0
const zone: HlZone = { side: 'low', left: T0 - 4 * 3_600_000, time: T0, right: null, top: 101, bottom: 100, lowTfLevel: 100, highTfLevel: 101 }
// sell stack: sell at row r >= 3 x buy at row r+1, rows 99.0 .. 100.0
const sellStack: [number, number, number][] = [[99, 0, 10], [99.5, 1, 10], [100, 1, 10], [100.5, 1, 1]]

describe('stackedRun', () => {
  it('counts diagonal imbalances in each direction', () => {
    const rows = new Map<number, [number, number]>(sellStack.map(([p, b, s]) => [p, [b, s]]))
    expect(stackedRun(rows, -1, 3, 0.02)).toBe(3)
    expect(stackedRun(rows, 1, 3, 0.02)).toBe(0)
    const buys = new Map<number, [number, number]>([[1, [1, 1]], [2, [9, 1]], [3, [9, 1]], [4, [9, 1]], [5, [1, 9]]])
    expect(stackedRun(buys, 1, 3, 0.02)).toBe(3)
  })
})

describe('detectBlockBreaks', () => {
  const lead = [bar(0, 103, 103.5, 102.5, 103), bar(1, 103, 103, 102, 102.2)]
  it('signals a break through the far edge with a stacked imbalance, then follows it to T2', () => {
    const bars = [
      ...lead,
      bar(2, 102.2, 102.2, 100.8, 101.0), // first touch from above
      bar(3, 101, 101, 100.2, 100.3),
      bar(4, 100.3, 100.4, 99.6, 99.8, sellStack),
      bar(5, 99.8, 99.9, 99.4, 99.5),
      bar(6, 99.5, 99.6, 99.3, 99.4), // window: bars 2..6, closes 99.4 < 100
      bar(7, 99.4, 99.4, 98.9, 99.0),
      bar(8, 99.0, 99.0, 94.0, 94.5), // runs through T1 and T2
    ]
    const r = detectBlockBreaks(bars, [zone], BLOCK_BREAK_DEFAULTS)
    expect(r.signals).toHaveLength(1)
    const s = r.signals[0]
    expect(s.dir).toBe(-1)
    expect(s.entry).toBe(99.4)
    expect(s.entryTime).toBe(T0 + 7 * MIN)
    expect(s.stop).toBeCloseTo(101 + 0.001 * 99.4, 9)
    const risk = s.stop - s.entry
    expect(s.t1).toBeCloseTo(99.4 - 2 * risk, 9)
    expect(s.t2).toBeCloseTo(99.4 - 3 * risk, 9)
    expect(s.outcome).toBe('t2')
    expect(s.r).toBeCloseTo(3, 9)
    expect(s.t1Time).toBe(T0 + 8 * MIN)
  })
  it('gives no signal without the stacked imbalance', () => {
    const bars = [...lead, bar(2, 102.2, 102.2, 100.8, 101), bar(3, 101, 101, 99.5, 99.6), bar(4, 99.6, 99.7, 99.2, 99.3), bar(5, 99.3, 99.4, 99.2, 99.3), bar(6, 99.3, 99.3, 99.1, 99.2), bar(7, 99.2, 99.2, 99, 99.1)]
    const r = detectBlockBreaks(bars, [zone], BLOCK_BREAK_DEFAULTS)
    expect(r.signals).toHaveLength(0)
    expect(r.passed[0].why).toMatch(/stacked/)
  })
  it('watches a touched block until its window has closed', () => {
    const bars = [...lead, bar(2, 102.2, 102.2, 100.8, 101), bar(3, 101, 101, 100.2, 100.3)]
    const r = detectBlockBreaks(bars, [zone], BLOCK_BREAK_DEFAULTS)
    expect(r.signals).toHaveLength(0)
    expect(r.watching).toHaveLength(1)
    expect(r.watching[0].windowEnd).toBe(T0 + 7 * MIN)
  })
  it('lists an untouched block as fresh, and spends one first touched from inside', () => {
    expect(detectBlockBreaks(lead, [zone], BLOCK_BREAK_DEFAULTS).fresh).toHaveLength(1)
    const inside = [bar(0, 100.5, 100.6, 100.4, 100.5), bar(1, 100.5, 100.7, 100.3, 100.6), bar(2, 100.6, 100.8, 100.2, 100.4)]
    const r = detectBlockBreaks(inside, [zone], BLOCK_BREAK_DEFAULTS)
    expect(r.fresh).toHaveLength(0)
    expect(r.passed[0].why).toMatch(/inside/)
  })
  it('skips a signal whose stop would be closer than the minimum', () => {
    const tight = { ...BLOCK_BREAK_DEFAULTS, minStopPct: 5 }
    const bars = [...lead, bar(2, 102.2, 102.2, 100.8, 101), bar(3, 101, 101, 100.2, 100.3), bar(4, 100.3, 100.4, 99.6, 99.8, sellStack), bar(5, 99.8, 99.9, 99.4, 99.5), bar(6, 99.5, 99.6, 99.3, 99.4), bar(7, 99.4, 99.4, 98.9, 99)]
    expect(detectBlockBreaks(bars, [zone], tight).signals).toHaveLength(0)
  })
})

describe('bars and rows', () => {
  it('folds prints into 1-minute footprint bars', () => {
    const bars: BbBar[] = []
    addPrintToBars(bars, T0 + 1_000, 100.2, 1, true, 0.5)
    addPrintToBars(bars, T0 + 2_000, 100.7, 2, false, 0.5)
    addPrintToBars(bars, T0 + MIN + 5, 99.9, 3, true, 0.5)
    expect(bars).toHaveLength(2)
    expect(bars[0]).toMatchObject({ open: 100.2, high: 100.7, low: 100.2, close: 100.7, volume: 3 })
    expect([...bars[0].rows.entries()]).toEqual([[100, [1, 0]], [100.5, [0, 2]]])
  })
  it('uses the researched row sizes for known symbols', () => {
    expect(autoRowSize(4100, 'XAUTUSD')).toBe(0.5)
    expect(autoRowSize(82000, 'BTCUSD')).toBe(10)
    expect(autoRowSize(2300, 'ETHUSD')).toBe(0.5)
    expect(autoRowSize(160, 'SOLUSD')).toBeCloseTo(0.02, 12)
  })
})
