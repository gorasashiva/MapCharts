import { describe, expect, it } from 'vitest'
import { autoRowSize, computeTpo, dayType, inferTick, periodStart, tpoLetter, valueArea, type TpoBar } from './tpoTvModel'

const MIN = 60_000
const D0 = Date.UTC(2026, 10, 2) // a Monday, 00:00 UTC
const bar = (min: number, low: number, high: number, vol = 1): TpoBar => ({ time: D0 + min * MIN, open: low, high, low, close: high, volume: vol })
const opts = { period: 'day' as const, blockMs: 30 * MIN, rowSize: 1, valueAreaPct: 70, ibBlocks: 2, dayStartHourUTC: 0 }

describe('tpoTvModel', () => {
  it('letters run A–Z then a–z, then repeat', () => {
    expect([0, 25, 26, 51, 52].map(tpoLetter).join('')).toBe('AZazA')
  })

  it('cuts the period into blocks from its start and puts each block on every row it covers', () => {
    // block A (00:00–00:30): 100–102; block B (00:30–01:00): 101–103
    const [p] = computeTpo([bar(0, 100, 101), bar(10, 101, 102), bar(30, 101, 103)], opts, D0 + 86_400_000)
    expect(p.blocks.map((b) => [b.index, b.low, b.high])).toEqual([[0, 100, 102], [1, 101, 103]])
    expect([...p.rows.entries()].sort((a, b) => a[0] - b[0])).toEqual([[100, [0]], [101, [0, 1]], [102, [0, 1]], [103, [1]]])
    expect(p.complete).toBe(true)
  })

  it('value area: start at the POC, add the bigger neighbour; ties go to the closer row, then the higher', () => {
    const counts = [1, 2, 4, 6, 4, 2, 1]
    const c = (r: number) => counts[r] ?? 0
    // total 20, target 14: POC 3 (6) → tie 4 vs 4, both 1 away → the higher (row 4): 10 → row 2 (4) beats row 5 (2): 14
    expect(valueArea(c, 0, 6, 3, 70)).toEqual([2, 4])
    // total 20, target 14: POC 3 (9) → row 2 (5) beats row 4 (3): 14
    const c2 = (r: number) => [3, 0, 5, 9, 3][r] ?? 0
    expect(valueArea(c2, 0, 4, 3, 70)).toEqual([2, 3])
  })

  it('POC, initial balance, single prints and poor extremes', () => {
    const bars = [
      bar(0, 100, 104), // A
      bar(30, 102, 104), // B
      bar(60, 103, 104), // C
      bar(90, 103, 109), // D — a run up: 105..108 only touched by D
    ]
    const [p] = computeTpo(bars, opts, D0)
    expect(p.poc).toBe(104) // A B C D
    expect(p.ib).toEqual([100, 104]) // the first two blocks
    expect(p.singles).toEqual([101, 105, 106, 107, 108])
    expect(p.poorHigh).toBe(false) // only D at 109
    expect(p.poorLow).toBe(false) // only A at 100
    expect(p.mid).toBe(105) // rows 100..109 span 100 → 110
    expect(p.complete).toBe(false)
  })

  it('a poor high: the top row was traded by more than one block', () => {
    const [p] = computeTpo([bar(0, 100, 105), bar(30, 101, 105)], opts, D0)
    expect(p.poorHigh).toBe(true)
  })

  it("TradingView's Auto row size: (high − low) / tick / 80, rounded to 5·10^k ticks", () => {
    // range 80 over 300 bars, tick 0.01 → 100 ticks a row → increment 50 → 100 ticks = 1.00
    const bars = Array.from({ length: 300 }, (_, i) => bar(i, 3900 + (i % 2 ? 80 : 0), 3900 + (i % 2 ? 80 : 0)))
    expect(autoRowSize(bars, 0.01)).toBe(1)
    // range 8 → 10 ticks → increment 5 → 10 ticks = 0.10
    const small = Array.from({ length: 300 }, (_, i) => bar(i, 100 + (i % 2 ? 8 : 0), 100 + (i % 2 ? 8 : 0)))
    expect(autoRowSize(small, 0.01)).toBe(0.1)
    expect(inferTick([bar(0, 3900.12, 3901.5)])).toBe(0.01)
  })

  it('periods: a 22:00 UTC session belongs to the next date; weeks start Monday, months on the 1st', () => {
    expect(periodStart(Date.UTC(2026, 10, 3, 1, 30), 'day', 22)).toBe(Date.UTC(2026, 10, 2, 22))
    expect(periodStart(Date.UTC(2026, 10, 2, 23), 'day', 22)).toBe(Date.UTC(2026, 10, 2, 22))
    expect(periodStart(Date.UTC(2026, 10, 5, 12), 'week', 0)).toBe(Date.UTC(2026, 10, 2))
    // the week's Monday session opens on Sunday 22:00
    expect(periodStart(Date.UTC(2026, 10, 5, 12), 'week', 22)).toBe(Date.UTC(2026, 10, 1, 22))
    expect(periodStart(Date.UTC(2026, 10, 20), 'month', 0)).toBe(Date.UTC(2026, 10, 1))
  })

  it('day types from the initial balance', () => {
    const trend = computeTpo([bar(0, 100, 101), bar(30, 100, 101), bar(60, 101, 104), bar(90, 104, 108)], opts, D0)[0]
    expect(dayType(trend)).toBe('Trend')
    const neutral = computeTpo([bar(0, 100, 102), bar(30, 100, 102), bar(60, 102, 104), bar(90, 97, 100)], opts, D0)[0]
    expect(dayType(neutral)).toBe('Neutral')
  })
})
