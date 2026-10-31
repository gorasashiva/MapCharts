import { describe, expect, it } from 'vitest'
import { LevelBook, PEAK_WINDOW_MS } from './levelBook'

const T = 1_791_558_109_000

describe('LevelBook', () => {
  it('ignores deltas before the first snapshot', () => {
    const b = new LevelBook()
    b.apply({ action: 'update', time: T, bids: [[100, 5]], asks: [] })
    expect(b.sizeAt('bid', 100)).toBe(0)
  })

  it('applies a snapshot, then per-level changes (0 removes)', () => {
    const b = new LevelBook()
    b.apply({ action: 'snapshot', time: T, bids: [[100, 5]], asks: [[101, 7]] })
    b.apply({ action: 'update', time: T + 10, bids: [[100, 3]], asks: [[101, 0]] })
    expect(b.sizeAt('bid', 100)).toBe(3)
    expect(b.sizeAt('ask', 101)).toBe(0)
  })

  it('remembers what a level showed just before a trade ate it', () => {
    const b = new LevelBook()
    b.apply({ action: 'snapshot', time: T, asks: [[4182.78, 10.919]], bids: [] })
    // Long-standing level, then eaten completely.
    b.apply({ action: 'update', time: T + 5_000, asks: [[4182.78, 0]], bids: [] })
    expect(b.sizeAt('ask', 4182.78)).toBe(0)
    expect(b.restingBefore('ask', 4182.78, T + 5_000)).toBeCloseTo(10.919)
    // Long after, the memory has expired.
    expect(b.restingBefore('ask', 4182.78, T + 5_000 + PEAK_WINDOW_MS * 2)).toBe(0)
  })

  it('a later snapshot replaces the book', () => {
    const b = new LevelBook()
    b.apply({ action: 'snapshot', time: T, bids: [[100, 5]], asks: [] })
    b.apply({ action: 'snapshot', time: T + 1, bids: [[99, 1]], asks: [] })
    expect(b.sizeAt('bid', 100)).toBe(0)
    expect(b.sizeAt('bid', 99)).toBe(1)
  })
})
