import { describe, expect, it } from 'vitest'
import type { Candle } from '../core/types'
import {
  PeriodClock,
  buildBuckets,
  buildProfile,
  editJoins,
  findNodes,
  findZones,
  groupPeriods,
  mergeSpans,
  parseHhMm,
  rowSizeFor,
  valueArea,
  zoneOffset,
  type DpPeriodSpec,
  type DpUnit,
} from './deepProfileModel'

const MIN = 60_000
const HOUR = 3_600_000
const utc = (s: string): number => Date.parse(s + 'Z')

const goldDays = (extra: Partial<DpPeriodSpec> = {}): PeriodClock =>
  new PeriodClock({
    lengthType: 'days',
    lengthValue: 1,
    anchorMinute: 18 * 60,
    anchorOffset: zoneOffset('NY'),
    splitMode: 'none',
    splitMinutes: [],
    splitOffset: zoneOffset('NY'),
    ...extra,
  })

const candle = (time: number, o: number, h: number, l: number, c: number, volume: number, extra: Partial<Candle> = {}): Candle => ({ time, open: o, high: h, low: l, close: c, volume, ...extra })
const print = (time: number, price: number, qty: number, side: 'buy' | 'sell'): DpUnit => ({ time, side, qty, levels: [[price, qty]] })
const opts = { rowSize: 1, valueAreaPct: 0.7, sensitivity: 1, detectNodes: false }

describe('PeriodClock', () => {
  it('opens the gold day at 18:00 New York, following US daylight saving', () => {
    const c = goldDays()
    // Summer (EDT, UTC-4): 18:00 NY = 22:00 UTC
    expect(c.periodStart(utc('2026-07-08T23:30:00'))).toBe(utc('2026-07-08T22:00:00'))
    expect(c.periodStart(utc('2026-07-08T21:59:00'))).toBe(utc('2026-07-07T22:00:00'))
    // Winter (EST, UTC-5): 18:00 NY = 23:00 UTC
    expect(c.periodStart(utc('2026-12-08T23:30:00'))).toBe(utc('2026-12-08T23:00:00'))
    expect(c.periodStart(utc('2026-12-08T22:30:00'))).toBe(utc('2026-12-07T23:00:00'))
  })

  it('handles the day the clocks change (US DST ends 2026-11-01)', () => {
    const c = goldDays()
    // Sunday 1 Nov 18:00 EST = 23:00 UTC; the open before it (Sat 31 Oct 18:00 EDT) was 22:00 UTC
    expect(c.periodStart(utc('2026-11-01T23:05:00'))).toBe(utc('2026-11-01T23:00:00'))
    expect(c.periodStart(utc('2026-11-01T22:30:00'))).toBe(utc('2026-10-31T22:00:00'))
  })

  it('splits a day at the RTH open (Splitted) and twice (Triple)', () => {
    const split = goldDays({ splitMode: 'splitted', splitMinutes: [8 * 60 + 20] })
    // 08:20 NY in summer = 12:20 UTC
    expect(split.periodStart(utc('2026-07-09T12:19:00'))).toBe(utc('2026-07-08T22:00:00'))
    expect(split.periodStart(utc('2026-07-09T12:20:00'))).toBe(utc('2026-07-09T12:20:00'))
    expect(split.periodStart(utc('2026-07-09T21:00:00'))).toBe(utc('2026-07-09T12:20:00'))
    const triple = goldDays({ splitMode: 'triple', splitMinutes: [8 * 60 + 20, 3 * 60] })
    // 03:00 NY = 07:00 UTC in summer
    expect(triple.periodStart(utc('2026-07-09T06:59:00'))).toBe(utc('2026-07-08T22:00:00'))
    expect(triple.periodStart(utc('2026-07-09T07:00:00'))).toBe(utc('2026-07-09T07:00:00'))
    expect(triple.periodStart(utc('2026-07-09T13:00:00'))).toBe(utc('2026-07-09T12:20:00'))
  })

  it('supports splits given in IST', () => {
    const c = new PeriodClock({ lengthType: 'days', lengthValue: 1, anchorMinute: 0, anchorOffset: zoneOffset('UTC'), splitMode: 'splitted', splitMinutes: [18 * 60 + 30], splitOffset: zoneOffset('IST') })
    // 18:30 IST = 13:00 UTC
    expect(c.periodStart(utc('2026-07-09T12:59:00'))).toBe(utc('2026-07-09T00:00:00'))
    expect(c.periodStart(utc('2026-07-09T13:00:00'))).toBe(utc('2026-07-09T13:00:00'))
  })

  it('groups minutes, hours, multi-day, weeks and months', () => {
    const base = { anchorMinute: 0, anchorOffset: zoneOffset('UTC'), splitMode: 'none' as const, splitMinutes: [], splitOffset: zoneOffset('UTC') }
    expect(new PeriodClock({ ...base, lengthType: 'minutes', lengthValue: 30 }).periodStart(utc('2026-07-09T10:47:00'))).toBe(utc('2026-07-09T10:30:00'))
    expect(new PeriodClock({ ...base, lengthType: 'hours', lengthValue: 4 }).periodStart(utc('2026-07-09T10:47:00'))).toBe(utc('2026-07-09T08:00:00'))
    const twoDay = new PeriodClock({ ...base, lengthType: 'days', lengthValue: 2 })
    const a = twoDay.periodStart(utc('2026-07-09T10:00:00'))
    const b = twoDay.periodStart(utc('2026-07-10T10:00:00'))
    const c = twoDay.periodStart(utc('2026-07-11T10:00:00'))
    expect(new Set([a, b, c]).size).toBe(2)
    // weeks start Monday (2026-07-06 is a Monday)
    expect(new PeriodClock({ ...base, lengthType: 'weeks', lengthValue: 1 }).periodStart(utc('2026-07-09T10:00:00'))).toBe(utc('2026-07-06T00:00:00'))
    expect(new PeriodClock({ ...base, lengthType: 'months', lengthValue: 1 }).periodStart(utc('2026-07-19T10:00:00'))).toBe(utc('2026-07-01T00:00:00'))
  })

  it("puts gold's Sunday-evening open in Monday's week", () => {
    const c = new PeriodClock({ lengthType: 'weeks', lengthValue: 1, anchorMinute: 18 * 60, anchorOffset: zoneOffset('NY'), splitMode: 'none', splitMinutes: [], splitOffset: zoneOffset('NY') })
    // Sunday 2026-07-12 18:00 EDT opens the week of Monday 13 July
    expect(c.periodStart(utc('2026-07-12T23:00:00'))).toBe(utc('2026-07-12T22:00:00'))
    expect(c.periodStart(utc('2026-07-17T15:00:00'))).toBe(utc('2026-07-12T22:00:00'))
  })
})

describe('buildBuckets', () => {
  const t0 = utc('2026-07-09T10:00:00')
  const candles = [candle(t0, 100, 104, 100, 103, 10), candle(t0 + MIN, 103, 105, 102, 104, 8)]
  const units = [print(t0 + 1000, 101, 2, 'buy'), print(t0 + 2000, 101, 1, 'sell'), print(t0 + 3000, 103, 5, 'buy'), print(t0 + MIN + 5, 104, 3, 'sell')]
  const f = { countTrades: false, minFilter: 0, maxFilter: 0 }

  it('uses exact prints where the tape covers the whole candle, else the candle estimate', () => {
    const spans: [number, number][] = [[t0 - 1, t0 + MIN]]
    const b = buildBuckets(candles, units, spans, MIN, f)
    expect(b[0].est).toBe(false)
    expect([...b[0].prices]).toEqual([101, 103])
    expect([...b[0].buy]).toEqual([2, 5])
    expect([...b[0].sell]).toEqual([1, 0])
    // second candle not covered → estimated from the candle (close-location split)
    expect(b[1].est).toBe(true)
    expect(b[1].estBuy + b[1].estSell).toBeCloseTo(8)
    expect(b[1].estBuy).toBeCloseTo(8 * (2 / 3))
  })

  it('prefers real taker buy volume for estimates', () => {
    const b = buildBuckets([candle(t0, 100, 104, 100, 103, 10, { buyVolume: 2 })], [], [], MIN, f)
    expect(b[0].estBuy).toBeCloseTo(2)
    expect(b[0].estSell).toBeCloseTo(8)
  })

  it('applies size filters to units and drops estimates while a filter is on', () => {
    const spans: [number, number][] = [[t0, t0 + MIN]]
    const b = buildBuckets(candles, units, spans, MIN, { countTrades: false, minFilter: 2, maxFilter: 4 })
    expect([...b[0].prices]).toEqual([101])
    expect([...b[0].buy]).toEqual([2])
    expect(b[1].estBuy + b[1].estSell).toBe(0)
  })

  it('counts trades instead of volume', () => {
    const spans: [number, number][] = [[t0, t0 + 2 * MIN]]
    const b = buildBuckets(candles, units, spans, MIN, { countTrades: true, minFilter: 0, maxFilter: 0 })
    expect([...b[0].buy]).toEqual([1, 1])
    expect([...b[0].sell]).toEqual([1, 0])
    expect([...b[1].sell]).toEqual([1])
  })

  it('counts a multi-level order once, at its largest level', () => {
    const order: DpUnit = { time: t0 + 10, side: 'buy', qty: 6, levels: [[101, 1], [102, 5]] }
    const b = buildBuckets(candles.slice(0, 1), [order], [[t0, t0 + MIN]], MIN, { countTrades: true, minFilter: 0, maxFilter: 0 })
    expect([...b[0].prices]).toEqual([102])
    expect([...b[0].buy]).toEqual([1])
  })

  it('rebuilds from an index (incremental tail)', () => {
    const b = buildBuckets(candles, units, [], MIN, f, 1)
    expect(b).toHaveLength(1)
    expect(b[0].time).toBe(t0 + MIN)
  })
})

describe('buildProfile', () => {
  const t0 = utc('2026-07-09T10:00:00')
  it('bins exact prints by row size, finds the POC and the developing POC', () => {
    const candles = [candle(t0, 100, 106, 100, 105, 0), candle(t0 + MIN, 105, 106, 100, 101, 0)]
    const units = [print(t0, 100.5, 1, 'buy'), print(t0 + 1, 101.2, 4, 'buy'), print(t0 + 2, 101.7, 1, 'sell'), print(t0 + MIN, 104.1, 9, 'sell')]
    const buckets = buildBuckets(candles, units, [[t0, t0 + 2 * MIN]], MIN, { countTrades: false, minFilter: 0, maxFilter: 0 })
    const p = buildProfile(buckets, t0, t0 + 2 * MIN, [t0], opts)!
    expect(p.rowLo).toBe(100)
    expect([...p.buy]).toEqual([1, 4, 0, 0, 0])
    expect([...p.sell]).toEqual([0, 1, 0, 0, 9])
    expect(p.pocRow).toBe(4) // 104 row: 9
    expect(p.developing).toEqual([
      [t0, 1],
      [t0 + MIN, 4],
    ])
    expect(p.totalBuy).toBe(5)
    expect(p.totalSell).toBe(10)
    expect(p.estShare).toBe(0)
  })

  it('spreads estimated candles over their rows and reports the estimated share', () => {
    const b = buildBuckets([candle(t0, 100, 101.9, 100, 101, 4)], [], [], MIN, { countTrades: false, minFilter: 0, maxFilter: 0 })
    const p = buildProfile(b, t0, t0 + MIN, [t0], opts)!
    expect(p.buy.length).toBe(2)
    expect(p.buy[0] + p.sell[0]).toBeCloseTo(2)
    expect(p.estShare).toBe(1)
  })

  it('returns null for an empty profile', () => {
    expect(buildProfile([], 0, 1, [0], opts)).toBeNull()
  })
})

describe('valueArea / findNodes', () => {
  it('grows the value area toward the heavier side', () => {
    const va = valueArea([1, 2, 10, 6, 1], 0.7)
    expect(va.pocRow).toBe(2)
    expect(va.valRow).toBe(2)
    expect(va.vahRow).toBe(3)
  })

  it('finds two peaks with a valley between, fewer at higher sensitivity', () => {
    const m = [1, 2, 8, 10, 8, 2, 1, 1, 2, 7, 9, 7, 2, 1]
    const low = findNodes(m, 1)
    expect(low.peaks).toEqual([3, 10])
    expect(low.valleys).toHaveLength(1)
    expect(low.valleys[0]).toBeGreaterThan(3)
    expect(low.valleys[0]).toBeLessThan(10)
    const high = findNodes(m, 6)
    expect(high.peaks.length).toBeLessThanOrEqual(1)
  })
})

describe('findZones', () => {
  // two volume humps (rows 2-4 and 9-11) with a thin gap between; buyers dominate the upper hump
  const tot = [1, 2, 8, 10, 8, 2, 1, 1, 2, 7, 9, 7, 2, 1]
  const buy = tot.map((v, r) => (r >= 8 ? v * 0.75 : v * 0.4))
  const sell = tot.map((v, r) => v - buy[r])
  const o = { prominence: 0.08, width: 0.5, maxEach: 3 }

  it('finds an HVN band on each hump and an LVN between them, in prices, with volume and delta', () => {
    // bin r = [100 + r, 101 + r). Smoothed (±1 bin): peaks 9 at bin 3 and 8 at bin 10, the dip
    // between bottoms at 1.25 (bin 6) → LVN = bins ≤ 1.25 + 0.5×6.75 = bins 5–8; HVNs stop at it.
    const zs = findZones(buy, sell, 100, 1, 1, o)
    const hvns = zs.filter((z) => z.kind === 'hvn')
    const lvns = zs.filter((z) => z.kind === 'lvn')
    expect(hvns.map((z) => [z.lo, z.hi])).toEqual([
      [102, 105],
      [109, 112],
    ])
    expect(lvns.map((z) => [z.lo, z.hi])).toEqual([[105, 109]])
    expect(hvns[0].volume).toBeCloseTo(26)
    expect(hvns[0].delta).toBeLessThan(0) // sellers on the lower hump
    expect(hvns[1].delta).toBeGreaterThan(0) // buyers on the upper hump
    expect(lvns[0].score).toBeCloseTo(0.75)
  })

  it('drops nodes below the prominence, never makes the thin tails LVNs, and caps zones per kind', () => {
    const zs = findZones(buy, sell, 100, 1, 1, { ...o, maxEach: 1 })
    expect(zs.filter((z) => z.kind === 'hvn')).toHaveLength(1)
    expect(zs.filter((z) => z.kind === 'lvn').every((z) => z.lo > 104 && z.hi < 110)).toBe(true)
    // the upper hump stands 6.75 above the dip = 75% of the POC: a 0.8 prominence leaves one HVN and no LVN
    const strict = findZones(buy, sell, 100, 1, 1, { ...o, prominence: 0.8 })
    expect(strict.map((z) => z.kind)).toEqual(['hvn'])
    // one hump only: no LVN anywhere
    expect(findZones([1, 2, 9, 2, 1, 0.5], [0, 0, 0, 0, 0, 0], 0, 1, 1, o).filter((z) => z.kind === 'lvn')).toEqual([])
    expect(findZones([1, 1], [1, 1], 0, 1, 1, o)).toEqual([])
  })

  it('is attached to built profiles only when asked for, independent of the row size', () => {
    const t0 = utc('2026-07-09T10:00:00')
    const units = tot.flatMap((v, r) => [print(t0 + r, 100 + r + 0.5, buy[r], 'buy'), print(t0 + r, 100 + r + 0.5, sell[r], 'sell')])
    units.sort((a, b) => a.time - b.time)
    const b = buildBuckets([candle(t0, 100, 114, 100, 110, 0)], units, [[t0, t0 + MIN]], MIN, { countTrades: false, minFilter: 0, maxFilter: 0 })
    expect(buildProfile(b, t0, t0 + MIN, [t0], opts)!.zones).toEqual([])
    const z1 = buildProfile(b, t0, t0 + MIN, [t0], { ...opts, sensitivity: 5, zones: o })!.zones
    const z2 = buildProfile(b, t0, t0 + MIN, [t0], { ...opts, rowSize: 2, sensitivity: 5, zones: o })!.zones
    expect(z1.length).toBeGreaterThan(0)
    expect(z2).toEqual(z1)
    for (const z of z1) {
      expect(z.lo).toBeGreaterThanOrEqual(100.5)
      expect(z.hi).toBeLessThanOrEqual(113.5 + 1e-9)
    }
  })
})

describe('grouping, merge and split', () => {
  const clock = new PeriodClock({ lengthType: 'hours', lengthValue: 1, anchorMinute: 0, anchorOffset: zoneOffset('UTC'), splitMode: 'none', splitMinutes: [], splitOffset: zoneOffset('UTC') })
  const t0 = utc('2026-07-09T10:00:00')
  const candles = [0, 1, 2, 3].map((h) => candle(t0 + h * HOUR, 100, 101, 99, 100, 1))
  const buckets = buildBuckets(candles, [], [], HOUR, { countTrades: false, minFilter: 0, maxFilter: 0 })

  it('one group per period, merged where joined', () => {
    expect(groupPeriods(buckets, clock, new Set()).map((g) => g.bases.length)).toEqual([1, 1, 1, 1])
    const g = groupPeriods(buckets, clock, new Set([t0 + HOUR, t0 + 2 * HOUR]))
    expect(g.map((x) => x.bases)).toEqual([[t0, t0 + HOUR, t0 + 2 * HOUR], [t0 + 3 * HOUR]])
    expect(g[0].i0).toBe(0)
    expect(g[0].i1).toBe(3)
  })

  it('Merge− / Merge+ / Split− / Split+ edit the joined set', () => {
    let j = editJoins([], 'merge+', [t0], [t0 + HOUR])
    expect(j).toEqual([t0 + HOUR])
    j = editJoins(j, 'merge-', [t0 + 2 * HOUR], null)
    expect(j).toEqual([t0 + HOUR, t0 + 2 * HOUR])
    // profile [t0, t0+1h, t0+2h]: split− detaches the first period, split+ the last
    expect(editJoins([t0 + HOUR, t0 + 2 * HOUR], 'split-', [t0, t0 + HOUR, t0 + 2 * HOUR], null)).toEqual([t0 + 2 * HOUR])
    expect(editJoins([t0 + HOUR, t0 + 2 * HOUR], 'split+', [t0, t0 + HOUR, t0 + 2 * HOUR], null)).toEqual([t0 + HOUR])
  })
})

describe('helpers', () => {
  it('rowSizeFor snaps auto rows to tidy tick multiples and honours manual ticks', () => {
    expect(rowSizeFor(0.01, true, 0.013, 6, 1, 1)).toBeCloseTo(0.1) // 7.8 ticks → 10
    expect(rowSizeFor(0.01, true, 0.0001, 6, 1, 1)).toBeCloseTo(0.01) // never below one tick
    expect(rowSizeFor(0.01, false, 1, 6, 5, 2)).toBeCloseTo(0.1) // manual 5 ticks × factor 2
    expect(rowSizeFor(0.01, true, 0.013, 6, 1, 3)).toBeCloseTo(0.3)
  })

  it('parseHhMm and mergeSpans', () => {
    expect(parseHhMm('08:20')).toBe(500)
    expect(parseHhMm('24:00')).toBeNull()
    expect(parseHhMm('x')).toBeNull()
    expect(
      mergeSpans([
        [5, 9],
        [1, 3],
        [2, 6],
        [10, 12],
      ]),
    ).toEqual([
      [1, 9],
      [10, 12],
    ])
  })
})
