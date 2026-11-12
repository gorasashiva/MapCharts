import { describe, expect, it } from 'vitest'
import type { BookTapeRecord } from './bookTape'
import { replayBookSnaps } from './domHeatmapModel'

const snap = (recvMs: number, bids: [number, number][], asks: [number, number][]): BookTapeRecord => ({
  kind: 'book',
  recvMs,
  exchMs: recvMs,
  action: 'snapshot',
  bids,
  asks,
})
const upd = (recvMs: number, bids: [number, number][], asks: [number, number][]): BookTapeRecord => ({
  kind: 'book',
  recvMs,
  exchMs: recvMs,
  action: 'update',
  bids,
  asks,
})
const opts = { from: 0, to: 100_000, sampleMs: 500, bandPct: 0.05 }

describe('replayBookSnaps', () => {
  it('applies a snapshot, then updates; qty 0 removes a level', () => {
    const recs: BookTapeRecord[] = [
      snap(1_000, [[99, 2], [98, 3]], [[101, 4]]),
      upd(2_000, [[99, 0]], [[101, 1], [102, 5]]),
    ]
    const out = replayBookSnaps(recs, opts)
    expect(out).toHaveLength(2)
    expect(out[0].bids.map((l) => l[0])).toEqual([99, 98])
    expect(out[1].bids).toEqual([[98, 3]])
    expect(out[1].asks).toEqual([[101, 1], [102, 5]])
  })

  it('ignores updates before the first snapshot', () => {
    const out = replayBookSnaps([upd(1_000, [[99, 2]], [[101, 4]]), snap(2_000, [[99, 2]], [[101, 4]])], opts)
    expect(out).toHaveLength(1)
    expect(out[0].t).toBe(2_000)
  })

  it('samples at most once per sampleMs', () => {
    const recs: BookTapeRecord[] = [snap(1_000, [[99, 2]], [[101, 4]])]
    for (let t = 1_100; t <= 2_600; t += 100) recs.push(upd(t, [[99, 2]], []))
    const out = replayBookSnaps(recs, { ...opts, sampleMs: 500 })
    expect(out.map((s) => s.t)).toEqual([1_000, 1_500, 2_000, 2_500])
  })

  it('keeps only levels within the band of the mid', () => {
    // mid = 100, band ±5% → 95..105
    const out = replayBookSnaps([snap(1_000, [[99, 2], [50, 9]], [[101, 4], [200, 1]])], opts)
    expect(out[0].bids).toEqual([[99, 2]])
    expect(out[0].asks).toEqual([[101, 4]])
  })

  it('drops the book at a gap until the next snapshot', () => {
    const recs: BookTapeRecord[] = [
      snap(1_000, [[99, 2]], [[101, 4]]),
      { kind: 'gap', recvMs: 2_000, reason: 'sequence break' },
      upd(3_000, [[99, 7]], []),
      snap(4_000, [[99, 1]], [[101, 1]]),
    ]
    const out = replayBookSnaps(recs, opts)
    expect(out.map((s) => s.t)).toEqual([1_000, 4_000])
    expect(out[1].bids).toEqual([[99, 1]])
  })

  it('emits nothing outside the requested window', () => {
    const out = replayBookSnaps([snap(1_000, [[99, 2]], [[101, 4]])], { ...opts, from: 5_000, to: 9_000 })
    expect(out).toEqual([])
  })
})
