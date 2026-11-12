import { describe, expect, it } from 'vitest'
import { MinuteAccumulator, heatGridFromRows, type MinuteRow } from './bookHeatRollup'
import type { BookSnap } from './domHeatmapModel'

const M = 60_000
const snap = (t: number, bids: [number, number][], asks: [number, number][]): BookSnap => ({ t, bids, asks })

describe('MinuteAccumulator', () => {
  it('averages each bin over the snapshots of one minute and closes minutes in order', () => {
    const acc = new MinuteAccumulator(1)
    // minute 0: two snapshots; the bid level is in the first only, the ask level in both
    expect(acc.add(snap(1_000, [[100, 2]], [[101, 1]]))).toEqual([])
    expect(acc.add(snap(2_000, [], [[101, 1]]))).toEqual([])
    // first snapshot of minute 1 closes minute 0
    const done = acc.add(snap(M + 500, [[100, 2]], []))
    expect(done).toHaveLength(1)
    const row = done[0]
    expect(row.m).toBe(0)
    expect(row.mid).toBeCloseTo(100.5, 9)
    const bin100 = row.bins.find((b) => b[0] === 100)
    expect(bin100?.[1]).toBeCloseTo((100 * 2) / 2, 9) // bid USD mean over 2 snapshots
    const bin101 = row.bins.find((b) => b[0] === 101)
    expect(bin101?.[2]).toBeCloseTo((101 * 1) / 1, 9) // ask USD: present in both → mean 101
  })

  it('flush returns the open minute once and then nothing', () => {
    const acc = new MinuteAccumulator(1)
    acc.add(snap(1_000, [[99, 1]], [[101, 1]]))
    expect(acc.flush()?.m).toBe(0)
    expect(acc.flush()).toBeNull()
  })
})

describe('heatGridFromRows', () => {
  const row = (m: number, bins: [number, number, number][]): MinuteRow => ({ m, step: 1, mid: 100, bins })

  it('averages a column over its minutes and keeps absolute prices', () => {
    // window of 2 minutes in one column; bin 99 bid is 100 USD in minute 0 and 300 USD in minute 1
    const rows = [row(0, [[99, 100, 0]]), row(M, [[99, 300, 0]])]
    const g = heatGridFromRows(rows, { from: 0, to: 2 * M, colMs: 2 * M, maxRows: 100, minUsd: 0 })
    expect(g.cols).toBe(1)
    expect(g.lo).toBe(99)
    expect(g.cells).toHaveLength(1)
    expect(g.cells[0].value).toBeCloseTo(200, 9)
    expect(g.cells[0].bid).toBe(true)
  })

  it('merges bins when the window spans more rows than allowed', () => {
    const rows = [row(0, [[10, 5, 0], [11, 5, 0], [12, 5, 0], [13, 5, 0]])]
    const g = heatGridFromRows(rows, { from: 0, to: M, colMs: M, maxRows: 2, minUsd: 0 })
    expect(g.rows).toBe(2)
    expect(g.step).toBe(2) // two bins per row
    expect(g.lo).toBe(10)
    // four bins of 5 USD fold into two rows of 10 USD each
    const total = g.cells.reduce((s, c) => s + c.value, 0)
    expect(total).toBeCloseTo(20, 9)
  })

  it('returns an empty grid when no minute falls in the window', () => {
    const g = heatGridFromRows([row(5 * M, [[99, 1, 0]])], { from: 0, to: M, colMs: M, maxRows: 10, minUsd: 0 })
    expect(g.cells).toEqual([])
    expect(g.mid).toBeNull()
  })
})
