import { describe, expect, it } from 'vitest'
import { barStats, cellIntensity, computeDeepStats, fmtStat } from './deepStatsModel'
import type { DpUnit } from './deepProfileModel'
import type { Candle } from '../core/types'

const T0 = Date.UTC(2026, 10, 3, 1, 0) // 01:00 UTC, BTC's session opened at 00:00
const u = (sec: number, side: 'buy' | 'sell', price: number, qty: number): DpUnit => ({ time: T0 + sec * 1000, side, qty, levels: [[price, qty]] })

// a bullish bar: opens 100, dips to 99, rallies to a high of 102, closes 101.5
const units: DpUnit[] = [
  u(0, 'buy', 100, 2),
  u(5, 'sell', 99.5, 3),
  u(10, 'sell', 99, 4), // low
  u(20, 'buy', 99.5, 5),
  u(30, 'buy', 101.5, 6),
  u(40, 'buy', 102, 1), // high (thin ask print)
  u(50, 'sell', 101.5, 2),
]

describe('barStats', () => {
  const s = barStats(units, 0.5, 60)!
  it('volumes, delta and counts', () => {
    expect(s.askVol).toBe(14)
    expect(s.bidVol).toBe(9)
    expect(s.totVol).toBe(23)
    expect(s.delta).toBe(5)
    expect(s.totNT).toBe(7)
    expect(s.deltaNT).toBe(1)
    expect(s.deltaPct).toBeCloseTo((5 / 23) * 100, 9)
  })
  it('running delta extremes', () => {
    // running: +2, -1, -5, 0, +6, +7, +5
    expect(s.maxDelta).toBe(7)
    expect(s.minDelta).toBe(-5)
  })
  it('range, effort, time, vol per second', () => {
    expect(s.deltaHL).toBe(6) // 99 .. 102 in 0.5 ticks
    expect(s.totEffort).toBeCloseTo(23 / 6, 9)
    expect(s.deltaEffort).toBeCloseTo(5 / 6, 9)
    expect(s.timeSec).toBe(50)
    expect(s.volPerSec).toBeCloseTo(23 / 60, 9)
  })
  it('close of trade from the high and the low', () => {
    // since the high (102 at 40s): +1 then -2 = -1; since the low (99 at 10s): -4 +5 +6 +1 -2 = +6
    expect(s.cotHigh).toBe(-1)
    expect(s.cotLow).toBe(6)
    expect(s.cotBar).toBe(-1) // bullish bar: COT H
  })
  it('extreme ratios', () => {
    // ask one tick under the high (101.5) = 6 vs ask at the high (102) = 1
    expect(s.highRatio).toBe(6)
    // bid one tick over the low (99.5) = 3 vs bid at the low (99) = 4
    expect(s.lowRatio).toBeCloseTo(0.75, 9)
    expect(s.barRatio).toBeCloseTo(0.75, 9) // bullish bar: low ratio
  })
})

describe('computeDeepStats', () => {
  const candles: Candle[] = [
    { time: T0, open: 100, high: 102, low: 99, close: 101.5, volume: 23 },
    { time: T0 + 60_000, open: 101.5, high: 102, low: 101, close: 101, volume: 3 },
    { time: T0 + 120_000, open: 101, high: 101, low: 100, close: 100.5, volume: 1 },
  ]
  const more = [...units, u(70, 'sell', 101, 3), u(130, 'buy', 100.5, 1)]
  it('only bars fully covered by tape get numbers; Delta Dly accumulates through the session', () => {
    const r = computeDeepStats(candles, more, [[T0, T0 + 120_000]], 60_000, 'BTCUSD', 0.5, { minFilter: 0, maxFilter: 0 }, T0 + 10 * 60_000)
    expect(r[0]?.cvd).toBe(5)
    expect(r[1]?.delta).toBe(-3)
    expect(r[1]?.cvd).toBe(2)
    expect(r[2]).toBeNull() // past the recorded span
  })
  it('min / max filters drop units', () => {
    const r = computeDeepStats(candles.slice(0, 1), units, [[T0, T0 + 60_000]], 60_000, 'BTCUSD', 0.5, { minFilter: 4, maxFilter: 0 }, T0 + 10 * 60_000)
    expect(r[0]?.totVol).toBe(15) // 4 + 5 + 6
  })
  it('Delta Dly restarts at the session open', () => {
    const late = Date.UTC(2026, 10, 3, 23, 59)
    const c2: Candle[] = [
      { time: late, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { time: late + 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ]
    const us: DpUnit[] = [{ time: late + 1000, side: 'buy', qty: 2, levels: [[1, 2]] }, { time: late + 61_000, side: 'buy', qty: 3, levels: [[1, 3]] }]
    const r = computeDeepStats(c2, us, [[late, late + 120_000]], 60_000, 'BTCUSD', 0.5, { minFilter: 0, maxFilter: 0 }, late + 10 * 60_000)
    expect(r[0]?.cvd).toBe(2)
    expect(r[1]?.cvd).toBe(3) // new UTC day = new BTC session
  })
})

describe('colouring and format', () => {
  it('signed values scale |v| by k·σ; unsigned by distance above the mean', () => {
    const signed = cellIntensity([-10, 0, 10, 20], 'delta', 1)
    expect(signed(0)).toBe(0)
    expect(signed(1e9)).toBe(1)
    const vol = cellIntensity([10, 10, 10, 50], 'totVol', 1)
    expect(vol(10)).toBe(0)
    expect(vol(50)).toBeGreaterThan(0.9)
  })
  it('formats cells compactly', () => {
    expect(fmtStat(12_345, 'totVol', true)).toBe('12.3K')
    expect(fmtStat(12_345, 'totVol', false)).toBe('12345')
    expect(fmtStat(33.4, 'deltaPct', true)).toBe('33%')
    expect(fmtStat(Infinity, 'highRatio', true)).toBe('∞')
  })
})
