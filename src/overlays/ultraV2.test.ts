import { describe, expect, it } from 'vitest'
import type { Candle } from '../core/types'
import { computeSvp, computeSvpZones, type SvpResult } from './ultraV2'

const T0 = Date.UTC(2026, 0, 5)

function svpOf(bins: number[], buyBins: number[] = bins.map((v) => v / 2)): SvpResult {
  let poc = 0
  bins.forEach((v, i) => { if (v > bins[poc]) poc = i })
  return { startTime: T0, endTime: T0, loPrice: 100, hiPrice: 100 + bins.length, step: 1, bins, buyBins, pocBin: poc, vahBin: poc, valBin: poc }
}

describe('computeSvpZones', () => {
  it('merges adjacent high-volume rows and classifies them against the live price', () => {
    // rows: 100-101 … 109-110. HVNs at rows 1-2 (101-103), 5 (105-106, POC), 8-9 (108-110).
    const svp = svpOf([1, 8, 9, 2, 1, 10, 3, 2, 7, 8])
    const zones = computeSvpZones(svp, 105.5, 70)
    expect(zones.map((z) => [z.lo, z.hi, z.kind, z.hasPoc])).toEqual([
      [101, 103, 'demand', false],
      [105, 106, 'inplay', true],
      [108, 110, 'supply', false],
    ])
  })

  it('reports the approximate buy share of each zone', () => {
    const svp = svpOf([10, 10], [8, 2])
    expect(computeSvpZones(svp, 50, 70)[0].buyPct).toBeCloseTo(50)
    const svp2 = svpOf([10, 1], [9, 0])
    expect(computeSvpZones(svp2, 200, 70)[0]).toMatchObject({ lo: 100, hi: 101, kind: 'demand', buyPct: 90 })
  })

  it('a lower threshold widens zones', () => {
    const svp = svpOf([4, 6, 10, 6, 4])
    expect(computeSvpZones(svp, 0, 90)).toHaveLength(1)
    expect(computeSvpZones(svp, 0, 50)[0]).toMatchObject({ lo: 101, hi: 104 })
  })
})

describe('computeSvp buy/sell split', () => {
  it('splits each bar by close location in its range', () => {
    const c: Candle[] = [
      { time: T0, open: 100, high: 110, low: 100, close: 110, volume: 10 }, // all buying
      { time: T0 + 60_000, open: 110, high: 110, low: 100, close: 100, volume: 10 }, // all selling
    ]
    const svp = computeSvp(c, 1, 0.7)!
    expect(svp.bins[0]).toBe(20)
    expect(svp.buyBins[0]).toBe(10)
  })

  it('row count sets zone granularity', () => {
    const c: Candle[] = []
    for (let i = 0; i < 60; i++) {
      const p = 100 + 10 * Math.sin(i / 6)
      c.push({ time: T0 + i * 60_000, open: p, high: p + 1, low: p - 1, close: p + 0.5, volume: 1 + (i % 7) })
    }
    const coarse = computeSvpZones(computeSvp(c, 6, 0.7)!, 100, 70)
    const fine = computeSvpZones(computeSvp(c, 48, 0.7)!, 100, 70)
    const avgWidth = (z: { lo: number; hi: number }[]) => z.reduce((s, x) => s + x.hi - x.lo, 0) / z.length
    expect(avgWidth(coarse)).toBeGreaterThan(avgWidth(fine))
  })
})
