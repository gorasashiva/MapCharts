import { describe, expect, it } from 'vitest'
import type { Candle } from '../core/types'
import { buildProfile, classifyCandles, footprintScan, isCashMinute, splitSessions } from './bullseyeModel'
import type { FpBarFlow } from './footprintBarStore'

const MIN = 60_000
const T0 = Date.UTC(2026, 10, 2, 0, 0) // 19:00 New York, away from the 09:30 opening blackout
const bar = (i: number, o: number, h: number, l: number, c: number, v: number): Candle => ({ time: T0 + i * 5 * MIN, open: o, high: h, low: l, close: c, volume: v })
const quiet = (n: number): Candle[] => Array.from({ length: n }, (_, i) => bar(i, 100, 100.5, 99.5, 100.1, 100))
const FUTURE = T0 + 365 * 86_400_000

describe('classifyCandles (geometric proxy)', () => {
  it('marks a heavy bar with a long lower wick that reclaims as demand absorption', () => {
    const c = [...quiet(25), bar(25, 100.8, 101, 99, 100.9, 300)]
    expect(classifyCandles(c, 5 * MIN, { effort: 5 }, FUTURE).slice(-1)[0]).toBe('gold')
  })

  it('marks a heavy wide-body up bar as an initiative bull drive', () => {
    const c = [...quiet(25), bar(25, 100, 102, 99.95, 101.9, 300)]
    expect(classifyCandles(c, 5 * MIN, { effort: 5 }, FUTURE).slice(-1)[0]).toBe('bullDrive')
  })

  it('marks a heavy long upper wick that rejects as supply absorption', () => {
    const c = [...quiet(25), bar(25, 99.2, 101, 99, 99.1, 300)]
    expect(classifyCandles(c, 5 * MIN, { effort: 5 }, FUTURE).slice(-1)[0]).toBe('purple')
  })
})

describe('buildProfile', () => {
  it('puts the POC inside the value area and calls a top-heavy profile P', () => {
    const bars = [bar(0, 100, 101, 100, 100.5, 10), ...Array.from({ length: 10 }, (_, i) => bar(i + 1, 100.75, 100.9, 100.7, 100.85, 100))]
    const p = buildProfile(bars, 'cash', true)!
    expect(p.lo).toBe(100)
    expect(p.hi).toBe(101)
    expect(p.poc).toBeGreaterThanOrEqual(p.val)
    expect(p.poc).toBeLessThanOrEqual(p.vah)
    expect(p.poc).toBeGreaterThan(100.65)
    expect(p.shape).toBe('P')
  })

  it('finds two separated balance areas as a B shape with an LVN between them', () => {
    const lowCluster = Array.from({ length: 10 }, (_, i) => bar(i, 100.1, 100.2, 100.05, 100.15, 100))
    const highCluster = Array.from({ length: 10 }, (_, i) => bar(i + 10, 100.85, 100.95, 100.8, 100.9, 100))
    const p = buildProfile([bar(20, 100, 101, 100, 100.5, 5), ...lowCluster, ...highCluster], 'on', true)!
    expect(p.shape).toBe('B')
    expect(p.lvn).not.toBeNull()
    expect(p.lvn!).toBeGreaterThan(100.2)
    expect(p.lvn!).toBeLessThan(100.8)
  })
})

describe('sessions', () => {
  it('starts the cash session at 09:30 New York', () => {
    const t = Date.UTC(2026, 10, 2, 14, 30) // 09:30 EST
    expect(isCashMinute(t)).toBe(true)
    expect(isCashMinute(t - MIN)).toBe(false)
    expect(isCashMinute(Date.UTC(2026, 10, 2, 21, 0))).toBe(false) // 16:00 EST
  })

  it('splits bars into alternating overnight and cash sessions', () => {
    const t = Date.UTC(2026, 10, 2, 14, 0) // 09:00 EST
    const c = Array.from({ length: 12 }, (_, i): Candle => ({ time: t + i * 5 * MIN, open: 1, high: 1, low: 1, close: 1, volume: 1 }))
    const s = splitSessions(c)
    expect(s.map((x) => x.kind)).toEqual(['on', 'cash'])
    expect(s[0].bars).toHaveLength(6)
  })
})

describe('footprint engine (our Volume Footprint rows)', () => {
  const rowsOf = (entries: [number, number, number][]): Map<number, [number, number]> => new Map(entries.map(([r, b, s]) => [r, [b, s]]))

  it('finds a stacked buy imbalance: buys at each row vs sells one row lower', () => {
    const rows = rowsOf([[100, 0, 1], [101, 5, 1], [102, 5, 1], [103, 5, 1], [104, 5, 0]])
    const s = footprintScan(rows, 1, 2.9, 3)
    expect(s.bullStack).toEqual([101, 104])
    expect(s.bearStack).toBeNull()
  })

  it('finds a stacked sell imbalance: sells at each row vs buys one row higher', () => {
    const rows = rowsOf([[100, 1, 5], [101, 1, 5], [102, 1, 5], [103, 1, 0]])
    const s = footprintScan(rows, 1, 2.9, 3)
    expect(s.bearStack).toEqual([100, 103])
    expect(s.bullStack).toBeNull()
  })

  it('uses footprint rows when a bar has them, and the candle shape when it does not', () => {
    const plain = bar(25, 100, 101, 99, 100, 100)
    const c = [...quiet(25), plain]
    const flow = new Map<number, FpBarFlow>([
      [plain.time, { delta: 15, vol: 25, sellLowShare: 0, buyHighShare: 0, rowSize: 1, rows: rowsOf([[100, 0, 1], [101, 5, 1], [102, 5, 1], [103, 5, 1], [104, 5, 0]]) }],
    ])
    expect(classifyCandles(c, 5 * MIN, { effort: 5 }, FUTURE).slice(-1)[0]).toBe('bull')
    expect(classifyCandles(c, 5 * MIN, { effort: 5 }, FUTURE, flow).slice(-1)[0]).toBe('gold')
  })
})

describe('daylight saving', () => {
  it('keeps the cash session at 09:30–16:00 New York in summer (EDT) and winter (EST)', () => {
    // July (EDT, UTC−4): 09:30 New York = 13:30 UTC = 19:00 IST
    expect(isCashMinute(Date.UTC(2026, 6, 15, 13, 30))).toBe(true)
    expect(isCashMinute(Date.UTC(2026, 6, 15, 13, 29))).toBe(false)
    expect(isCashMinute(Date.UTC(2026, 6, 15, 20, 0))).toBe(false) // 16:00 EDT
    // November (EST, UTC−5): 09:30 New York = 14:30 UTC = 20:00 IST
    expect(isCashMinute(Date.UTC(2026, 10, 16, 14, 30))).toBe(true)
    expect(isCashMinute(Date.UTC(2026, 10, 16, 13, 30))).toBe(false)
  })

  it('moves the session with the clock change itself (US DST ended 1 Nov 2026)', () => {
    // Friday 30 Oct (EDT): opens 13:30 UTC; Monday 2 Nov (EST): opens 14:30 UTC
    expect(isCashMinute(Date.UTC(2026, 9, 30, 13, 30))).toBe(true)
    expect(isCashMinute(Date.UTC(2026, 10, 2, 13, 30))).toBe(false)
    expect(isCashMinute(Date.UTC(2026, 10, 2, 14, 30))).toBe(true)
  })
})
