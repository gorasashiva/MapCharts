import { describe, expect, it } from 'vitest'
import { bandRuns, buildHeatGrid, levelLabels, strongRows, type BookSnap } from './domHeatmapModel'

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

  it('picks the strongest rows by total size over the window', () => {
    // row for 99.5 is big in both columns; 98.5 is a single big spike; 100.5 is small but steady
    const snaps: BookSnap[] = [
      { t: 1_000, bids: [[99.5, 10], [98.5, 2]], asks: [[100.5, 1]] },
      { t: 7_000, bids: [[99.5, 10]], asks: [[100.5, 1]] },
    ]
    const g = buildHeatGrid(snaps, base)
    const top = strongRows(g, 1)
    expect(top.has(Math.floor((99.5 - g.lo) / g.step))).toBe(true)
    expect(top.size).toBe(1)
    expect(strongRows(g, 0).size).toBe(0)
  })

  it('merges consecutive columns of one level into runs', () => {
    // window 0..30 s in 5 s columns (6 columns); the bid at 99.5 rests in columns 0,1,2 and 4
    const win = { now: 30_000, historyMs: 30_000, colMs: 5_000, mid: 100, rangePct: 0.05, rows: 10, minUsd: 0 }
    const snaps: BookSnap[] = [2_000, 7_000, 12_000, 22_000].map((t) => ({ t, bids: [[99.5, 10]], asks: [] }))
    const g = buildHeatGrid(snaps, win)
    const row = Math.floor((99.5 - g.lo) / g.step)
    const runs = bandRuns(g, new Set([row]))
    expect(runs.map((r) => [r.c0, r.c1])).toEqual([[0, 2], [4, 4]])
    expect(runs.every((r) => r.bid && r.intensity > 0 && r.intensity <= 1)).toBe(true)
  })

  it('labels each strong level with its mean size over the window', () => {
    const win = { now: 30_000, historyMs: 30_000, colMs: 5_000, mid: 100, rangePct: 0.05, rows: 10, minUsd: 0 }
    const snaps: BookSnap[] = [2_000, 7_000, 12_000, 22_000].map((t) => ({ t, bids: [[99.5, 10]], asks: [] }))
    const g = buildHeatGrid(snaps, win)
    const row = Math.floor((99.5 - g.lo) / g.step)
    const labels = levelLabels(g, new Set([row]))
    expect(labels).toHaveLength(1)
    // 4 of 6 columns carry 995 USD each → mean over the window = 995 * 4 / 6
    expect(labels[0].usd).toBeCloseTo((995 * 4) / 6, 6)
    expect(labels[0].bid).toBe(true)
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
