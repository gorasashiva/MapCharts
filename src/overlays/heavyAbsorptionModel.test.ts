import { describe, expect, it } from 'vitest'
import { absorptionPrice, barIndexAt, computeHeavyAbsorption, type AbsBar, type AbsOrder } from './heavyAbsorptionModel'

const MIN = 60_000

/** n flat 1-minute bars around `mid`, each with 20 small orders; overrides per bar. */
function setup(n: number, mid = 100, over: Record<number, Partial<AbsBar>> = {}): { bars: AbsBar[]; orders: AbsOrder[] } {
  const bars: AbsBar[] = []
  const orders: AbsOrder[] = []
  for (let i = 0; i < n; i++) {
    const t = i * MIN
    bars.push({ time: t, open: mid, high: mid + 1, low: mid - 1, close: mid, ...over[i] })
    for (let k = 0; k < 20; k++) orders.push({ time: t + k * 1000, price: mid, qty: 1 + (k % 5) * 0.1, side: k % 2 ? 'buy' : 'sell' })
  }
  return { bars, orders }
}
const insert = (orders: AbsOrder[], o: AbsOrder): AbsOrder[] => [...orders, o].sort((a, b) => a.time - b.time)

describe('heavyAbsorptionModel', () => {
  it('maps a time to the bar it printed in', () => {
    const bars = setup(3).bars
    expect(barIndexAt(bars, -1)).toBe(-1)
    expect(barIndexAt(bars, MIN + 5)).toBe(1)
    expect(barIndexAt(bars, 10 * MIN)).toBe(2)
  })

  it('prices an order at the level that took the most of it', () => {
    expect(absorptionPrice([[100, 1], [100.5, 7], [101, 2]])).toBe(100.5)
  })

  it('flags an outlier order once the lookback has enough samples, not before', () => {
    const { bars, orders } = setup(40)
    const big = (i: number): AbsOrder => ({ time: i * MIN + 500, price: 100.5, qty: 50, side: 'buy' })
    const r = computeHeavyAbsorption(bars, insert(insert(orders, big(0)), big(30)), { lookback: 20, minSamples: 30 })
    // bar 0 has no history → no threshold; bar 30 does
    expect(Number.isNaN(r.threshold[0])).toBe(true)
    expect(r.markers.map((m) => m.barIndex)).toEqual([30])
    expect(r.markers[0]).toMatchObject({ side: 'buy', price: 100.5, volume: 50 })
  })

  it('all three threshold methods catch a clear outlier and ignore normal orders', () => {
    const { bars, orders } = setup(60)
    const withBig = insert(orders, { time: 50 * MIN + 500, price: 100, qty: 40, side: 'sell' })
    for (const method of ['percentile', 'logSigma', 'sigma'] as const) {
      const r = computeHeavyAbsorption(bars, withBig, { method, lookback: 30, percentile: 99.5, stdMult: 3 })
      expect(r.markers.map((m) => [m.barIndex, m.side])).toEqual([[50, 'sell']])
    }
  })

  it("groups a bar's big orders per side at the largest one", () => {
    const { bars, orders } = setup(40)
    let os = insert(orders, { time: 35 * MIN + 100, price: 101, qty: 30, side: 'buy' })
    os = insert(os, { time: 35 * MIN + 200, price: 100.8, qty: 60, side: 'buy' })
    const grouped = computeHeavyAbsorption(bars, os, { lookback: 20 })
    expect(grouped.markers).toHaveLength(1)
    expect(grouped.markers[0]).toMatchObject({ price: 100.8, volume: 90, orders: 2 })
    expect(computeHeavyAbsorption(bars, os, { lookback: 20, group: 'order' }).markers).toHaveLength(2)
  })

  it('absorbed when price can not get past the big buy; failed when it breaks through', () => {
    // big buy at 101 in bar 30; bar 30 closes back at 100
    const big: AbsOrder = { time: 30 * MIN + 100, price: 101, qty: 50, side: 'buy' }
    const held = setup(40)
    const r1 = computeHeavyAbsorption(held.bars, insert(held.orders, big), { lookback: 20, confirmBars: 3, tolAtr: 0.25 })
    expect(r1.markers[0].verdict).toBe('absorbed')
    expect(r1.markers[0].brokenAt).toBeNull()

    const broke = setup(40, 100, { 32: { high: 105, close: 104 } })
    const r2 = computeHeavyAbsorption(broke.bars, insert(broke.orders, big), { lookback: 20, confirmBars: 3, tolAtr: 0.25 })
    expect(r2.markers[0].verdict).toBe('failed')

    // held through the confirmation bars, broken later → the level ends there
    const later = setup(40, 100, { 37: { high: 106, close: 105 } })
    const r3 = computeHeavyAbsorption(later.bars, insert(later.orders, big), { lookback: 20, confirmBars: 3, tolAtr: 0.25 })
    expect(r3.markers[0]).toMatchObject({ verdict: 'absorbed', brokenAt: 37 })
  })

  it('stays pending until the confirmation bars exist', () => {
    const { bars, orders } = setup(32)
    const r = computeHeavyAbsorption(bars, insert(orders, { time: 30 * MIN + 100, price: 99, qty: 50, side: 'sell' }), { lookback: 20, confirmBars: 3 })
    expect(r.markers[0].verdict).toBe('pending')
  })
})
