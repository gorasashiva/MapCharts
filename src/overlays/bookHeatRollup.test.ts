import { describe, expect, it } from 'vitest'
import { MinuteAccumulator, heatGridFromRows, mergeRows, tradesAndBboFromRows, zoneReactions, type MinuteRow } from './bookHeatRollup'
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

describe('trades and best bid / ask in rollups', () => {
  it('attaches trades to their minute and bin, buy and sell apart, and keeps best prices', () => {
    const acc = new MinuteAccumulator(1)
    acc.add(snap(1_000, [[100, 2]], [[101, 1]]))
    acc.addTrade({ recvMs: 2_000, price: 100.5, qty: 2, buy: true })
    acc.addTrade({ recvMs: 3_000, price: 100.2, qty: 1, buy: false })
    acc.addTrade({ recvMs: M + 1_000, price: 101, qty: 1, buy: true }) // belongs to the next minute
    const row = acc.add(snap(M + 500, [[100, 2]], [[101, 1]]))[0]
    expect(row.bb).toBeCloseTo(100, 9)
    expect(row.ba).toBeCloseTo(101, 9)
    const bin100 = row.tr.find((t) => t[0] === 100)
    expect(bin100?.[1]).toBeCloseTo(201, 9) // buy 100.5 × 2
    expect(bin100?.[2]).toBeCloseTo(100.2, 9) // sell 100.2 × 1
    expect(bin100?.[3]).toBe(2)
    expect(row.tr.find((t) => t[0] === 101)).toBeUndefined()
  })

  it('places trades and best prices on the grid cells of their minute', () => {
    const rows: MinuteRow[] = [
      { m: 0, step: 1, mid: 100, bb: 99, ba: 101, bins: [[99, 10, 0]], tr: [[99, 40, 0, 1]] },
      { m: M, step: 1, mid: 100, bb: 100, ba: 102, bins: [[99, 10, 0]], tr: [[99, 0, 60, 2]] },
    ]
    const grid = heatGridFromRows(rows, { from: 0, to: 2 * M, colMs: M, maxRows: 100, minUsd: 0 })
    const tb = tradesAndBboFromRows(rows, grid, { from: 0, to: 2 * M })
    expect(tb.trades).toHaveLength(2)
    expect(tb.trades.find((t) => t.col === 0)).toMatchObject({ buy: 40, sell: 0, n: 1 })
    expect(tb.trades.find((t) => t.col === 1)).toMatchObject({ buy: 0, sell: 60, n: 2 })
    expect(tb.bbo.map((b) => [b.col, b.bid, b.ask])).toEqual([
      [0, 99, 101],
      [1, 100, 102],
    ])
  })
})

describe('heatGridFromRows', () => {
  const row = (m: number, bins: [number, number, number][]): MinuteRow => ({ m, step: 1, mid: 100, bb: 99, ba: 101, bins, tr: [] })

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

describe('zones and reactions', () => {
  it('merges rows that are close together into one zone', () => {
    expect(mergeRows([9, 4, 5, 6], 2)).toEqual([[4, 5, 6], [9]])
    expect(mergeRows([4, 6, 8, 10], 2)).toEqual([[4, 6, 8, 10]])
  })

  it('counts touches and marks the reaction when price leaves the zone', () => {
    const mk = (m: number, mid: number): MinuteRow => ({ m, step: 1, mid, bb: mid - 0.5, ba: mid + 0.5, bins: [], tr: [] })
    // zone 100..101; price touches at minute 1, then moves 0.5% away (100.5 is 0.5% above 100.5? use 102)
    const rows = [mk(0, 105), mk(M, 100.5), mk(2 * M, 100.6), mk(3 * M, 102), mk(4 * M, 100.5)]
    const z = zoneReactions(rows, 100, 101, { reactPct: 0.005, windowMin: 15 })
    expect(z.touches).toBe(2) // entered at minute 1 and again at minute 4
    expect(z.reactions).toBe(1) // only the first touch moved away
    expect(z.reactMs).toEqual([3 * M])
  })
})
