import { describe, expect, it } from 'vitest'
import { computeMapTrades, mapTradeLevels, type MapSessionLevels, type MapTradeBar } from './mapV3TradesModel'

const MIN5 = 300_000
// a Monday, so the weekend rule stays out of the way
const MON = Date.UTC(2026, 10, 2, 14, 0)
const bar = (i: number, o: number, h: number, l: number, c: number): MapTradeBar => ({ time: MON + i * MIN5, open: o, high: h, low: l, close: c })

// Put Wall 100, Gamma Flip 95 (price above: positive regime), HVL 106, Call Wall 110
const SES: MapSessionLevels = {
  id: '2026-11-02',
  flip: 95,
  levels: [
    { price: 100, name: 'Put Wall' },
    { price: 106, name: 'HVL' },
    { price: 110, name: 'Call Wall' },
  ],
}
const flat = (n: number, mid = 103): MapTradeBar[] => Array.from({ length: n }, (_, i) => bar(i, mid, mid + 1, mid - 1, mid))

describe('mapV3TradesModel', () => {
  it('Touch & Bounce at the Put Wall in a positive regime: long at the rejection close, T1 / T2 at the next levels', () => {
    const bars = flat(15)
    // wicks to 99.6 through the wall, closes back at 101.8 (long lower wick)
    bars.push(bar(15, 101.5, 102, 99.6, 101.8))
    const [t] = computeMapTrades(bars, () => SES)
    expect(t).toMatchObject({ setup: 'bounce', side: 1, regime: 'positive', entry: 101.8, t1: 106, t1Name: 'HVL', t2: 110, t2Name: 'Call Wall', outcome: 'open' })
    expect(t.level.name).toBe('Put Wall')
    expect(t.stop).toBeLessThan(99.6)
  })

  it('no Touch & Bounce below the Gamma Flip (negative regime) unless asked', () => {
    const neg = { ...SES, flip: 104 }
    const bars = [...flat(15), bar(15, 101.5, 102, 99.6, 101.8)]
    expect(computeMapTrades(bars, () => neg)).toHaveLength(0)
    expect(computeMapTrades(bars, () => neg, { bounceInNegative: true })[0]).toMatchObject({ setup: 'bounce', regime: 'negative' })
  })

  it('Break & Retest: close through a level, come back to it, hold — long at the retest close', () => {
    const bars = flat(15, 104)
    bars.push(bar(15, 105, 108, 104.8, 107.8)) // closes through HVL 106
    bars.push(bar(16, 107.8, 108.5, 107, 108))
    bars.push(bar(17, 108, 108.2, 105.9, 107.2)) // back to 106, holds above
    // HVL is a magnet, not an entry level, by default
    expect(computeMapTrades(bars, () => SES, { touchBounce: false })).toHaveLength(0)
    const [t] = computeMapTrades(bars, () => SES, { touchBounce: false, entryAll: true })
    expect(t).toMatchObject({ setup: 'retest', side: 1, index: 17, entry: 107.2, t1: 110, t2: null })
    expect(t.level.name).toBe('HVL')
  })

  it('partial at T1, stop to breakeven, the rest to T2; a stop before T1 is −1R', () => {
    const base = [...flat(15), bar(15, 101.5, 102, 99.6, 101.8)]
    const win = [...base, bar(16, 102, 106.5, 101.9, 106), bar(17, 106, 110.5, 105.8, 110)]
    const t = computeMapTrades(win, () => SES)[0]
    const risk = t.entry - t.stop
    expect(t.outcome).toBe('t2')
    expect(t.r).toBeCloseTo(0.5 * ((106 - t.entry) / risk) + 0.5 * ((110 - t.entry) / risk), 3)
    const be = [...base, bar(16, 102, 106.5, 101.9, 106), bar(17, 106, 106.2, 101, 101.5)]
    expect(computeMapTrades(be, () => SES)[0]).toMatchObject({ outcome: 'breakeven' })
    const loss = [...base, bar(16, 101.8, 102, 98, 98.5)]
    expect(computeMapTrades(loss, () => SES)[0]).toMatchObject({ outcome: 'stop', r: -1 })
  })

  it('footprint confirmation: tagged, or required', () => {
    const bars = [...flat(15), bar(15, 101.5, 102, 99.6, 101.8)]
    expect(computeMapTrades(bars, () => SES, {}, () => true)[0].fp).toBe(true)
    expect(computeMapTrades(bars, () => SES, { requireConfirm: true }, () => false)).toHaveLength(0)
    expect(computeMapTrades(bars, () => SES, { requireConfirm: true }, () => null)).toHaveLength(0)
  })

  it('no new trades on weekends', () => {
    const sat = Date.UTC(2026, 10, 7, 14, 0)
    const bars = [...flat(15), bar(15, 101.5, 102, 99.6, 101.8)].map((b, i) => ({ ...b, time: sat + i * MIN5 }))
    expect(computeMapTrades(bars, () => SES)).toHaveLength(0)
  })

  it('maps MAP V3 levels, merging ones at the same price', () => {
    const l = mapTradeLevels({ callWall: 110, putWall: 100, flip: 100, hvl: 106, maxPain: NaN, z: { call: 108, put: 101 } })
    expect(l.map((x) => [x.price, x.name])).toEqual([
      [100, 'Put Wall · Gamma Flip'],
      [101, '0DTE Put'],
      [106, 'HVL'],
      [108, '0DTE Call'],
      [110, 'Call Wall'],
    ])
  })
})
