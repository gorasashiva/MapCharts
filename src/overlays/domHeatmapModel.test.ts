import { describe, expect, it } from 'vitest'
import { buildHeatGrid, type BookSnap } from './domHeatmapModel'

const base = { now: 10_000, historyMs: 10_000, colMs: 5_000, mid: 100, rangePct: 0.05, rows: 10, minUsd: 0 }

describe('buildHeatGrid', () => {
  it('splits history into columns and rows of the price band', () => {
    const g = buildHeatGrid([], base)
    expect(g.cols).toBe(2)
    expect(g.rows).toBe(10)
    expect(g.lo).toBeCloseTo(95, 9)
    expect(g.step).toBeCloseTo(1, 9)
    expect(g.cells).toEqual([])
  })

  it('averages resting USD over the snapshots in each column', () => {
    const snaps: BookSnap[] = [
      // column 0 (t 0..5000): two snapshots, one with the level, one without → mean is half
      { t: 1_000, bids: [[99.5, 10]], asks: [] },
      { t: 2_000, bids: [], asks: [] },
      // column 1: one snapshot with an ask at 101.2
      { t: 7_000, bids: [], asks: [[101.2, 4]] },
    ]
    const g = buildHeatGrid(snaps, base)
    const bid = g.cells.find((c) => c.bid && c.col === 0)
    expect(bid?.value).toBeCloseTo((99.5 * 10) / 2, 6)
    const ask = g.cells.find((c) => !c.bid && c.col === 1)
    expect(ask?.value).toBeCloseTo(101.2 * 4, 6)
    expect(ask?.row).toBe(Math.floor((101.2 - 95) / 1))
  })

  it('drops levels outside the band and below the minimum size', () => {
    const snaps: BookSnap[] = [{ t: 1_000, bids: [[80, 10], [99, 0.1]], asks: [[120, 10]] }]
    const g = buildHeatGrid(snaps, { ...base, minUsd: 100 })
    expect(g.cells).toEqual([])
  })

  it('ignores snapshots outside the history window', () => {
    const snaps: BookSnap[] = [{ t: -5, bids: [[99.5, 10]], asks: [] }] // window starts at t0 = 0
    expect(buildHeatGrid(snaps, base).cells).toEqual([])
  })

  it('sets full intensity at the 95th percentile of cell values', () => {
    const snaps: BookSnap[] = [{ t: 1_000, bids: [[99.5, 10], [98.5, 2]], asks: [[100.5, 3]] }]
    const g = buildHeatGrid(snaps, base)
    expect(g.scale).toBeGreaterThan(0)
  })
})
