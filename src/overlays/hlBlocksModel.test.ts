import { describe, expect, it } from 'vitest'
import type { Candle } from '../core/types'
import { HL_BLOCKS_DEFAULTS, computeHlBlocks, zoneBounds, type HlBlocksOptions } from './hlBlocksModel'

const M15 = 15 * 60_000
const H = 3_600_000

/** 15m bars from `start`, flat around 100; `highs` overrides the high per hour index (and lifts that hour's low to 104). */
function bars(hours: number, highs: Record<number, number> = {}, start = 0): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < hours * 4; i++) {
    const time = start + i * M15
    const high = highs[Math.floor(i / 4)] ?? 100.5
    out.push({ time, open: 100, high, low: high > 100.5 ? 104 : 99.5, close: 100, volume: 1 })
  }
  return out
}
const opts = (o: Partial<HlBlocksOptions> = {}): HlBlocksOptions => ({ ...HL_BLOCKS_DEFAULTS, showLow: false, ...o })

describe('1H / 4H Block', () => {
  it('zone when the last closed 1H high matches the last closed 4H high', () => {
    // 4H #0 (hours 0-3) peaks at 110 in hour 3; hour 4 (in 4H #1) tops at 110.05.
    const r = computeHlBlocks(bars(12, { 3: 110, 4: 110.05 }), opts(), 900)
    expect(r.error).toBeNull()
    expect(r.zones).toHaveLength(1)
    const z = r.zones[0]
    expect(z.side).toBe('high')
    expect(z.left).toBe(0) // the 4H candle's open
    expect(z.time).toBe(5 * H) // first bar of the next 1H
    expect(z.top).toBeCloseTo(110.05)
    expect(z.bottom).toBeCloseTo(110)
    expect(z.right).toBeNull()
  })

  it('skips the 1H candle that closes with the 4H candle (it is part of it)', () => {
    // Hour 3's high IS the 4H high; compared at hour 4 (a new 4H) it would trivially match.
    // (Later flat 100.5 candles match each other legitimately — only 4H #0 matters here.)
    expect(computeHlBlocks(bars(12, { 3: 110 }), opts(), 900).zones.filter((z) => z.left === 0)).toHaveLength(0)
  })

  it('one zone per 4H candle unless switched off; a newer zone ends the previous one', () => {
    const b = bars(12, { 3: 110, 4: 110.05, 5: 110.02 })
    expect(computeHlBlocks(b, opts(), 900).zones).toHaveLength(1)
    const all = computeHlBlocks(b, opts({ onePerHigh: false }), 900).zones
    expect(all).toHaveLength(2)
    expect(all[0].right).toBe(6 * H)
    expect(all[1].right).toBeNull()
    expect(computeHlBlocks(b, opts({ onePerHigh: false, maxZones: 1 }), 900).zones).toHaveLength(1)
  })

  it('outside the tolerance there is no zone', () => {
    expect(computeHlBlocks(bars(12, { 3: 110, 4: 110.5 }), opts(), 900).zones).toHaveLength(0)
  })

  it('low zones mirror the highs', () => {
    // Hour 5's low (99.5) matches 4H #0's low at hour 6.
    const r = computeHlBlocks(bars(8, { 3: 110, 4: 110.05 }), opts({ showHigh: false, showLow: true }), 900)
    expect(r.zones).toHaveLength(1)
    expect(r.zones[0]).toMatchObject({ side: 'low', left: 0, time: 6 * H })
    expect(r.zones[0].bottom).toBeLessThan(99.5)
    expect(r.zones[0].top).toBeGreaterThan(99.5)
  })

  it('ignores a partial first 4H candle when history starts mid-candle', () => {
    expect(computeHlBlocks(bars(12, { 2: 110, 3: 110.05 }, H), opts(), 900).zones).toHaveLength(0)
  })

  it('pads near-identical levels to the minimum height', () => {
    const z = zoneBounds(100, 100, 0.4, 0.25)
    expect(z.top - z.bottom).toBeCloseTo(0.1)
    expect((z.top + z.bottom) / 2).toBeCloseTo(100)
  })

  it('reports an error above the lower timeframe or with inverted timeframes', () => {
    expect(computeHlBlocks(bars(12), opts(), 14_400).error).toMatch(/1H or lower/)
    expect(computeHlBlocks(bars(12), opts({ tfLow: 14_400, tfHigh: 3600 }), 900).error).toMatch(/higher timeframe/)
  })
})
