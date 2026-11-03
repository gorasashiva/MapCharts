import { describe, expect, it } from 'vitest'
import { FootprintSignalsLayer, type FpSignalTrade } from './footprintSignalsLayer'

const MIN = 60_000
const candle = (i: number, low: number, high: number) => ({ time: i * MIN, open: low, high, low, close: high, volume: 1 })
const longTrade = (): FpSignalTrade => ({
  setup: 'absorb', side: 1, signalIndex: 0, entryIndex: 1, entry: 100, stop: 98, target: 104, zone: [98.5, 101],
  exitIndex: null, exitPrice: null, outcome: 'open', r: null, why: '', signalTime: 0, entryTime: MIN, exitTime: null,
})
type Inner = {
  gexMatch: Map<string, unknown>
  formingHit: Map<string, 'target' | 'stop'>
  useGexTarget(t: FpSignalTrade, c: ReturnType<typeof candle>[]): void
  shown(t: FpSignalTrade, lastT: number): FpSignalTrade
}

describe('footprintSignalsLayer', () => {
  it('a GEX level nearer than the R target becomes the target, and the trade closes there', () => {
    const layer = new FootprintSignalsLayer() as unknown as Inner
    const t = longTrade()
    layer.gexMatch.set('absorb|1|0', { at: { price: 98.5, label: 'S1', strength: 80 }, next: { price: 102.5, label: 'R1', strength: 70 } })
    // price reaches 103 (past the GEX level, short of the 2R target at 104)
    layer.useGexTarget(t, [candle(0, 98.5, 101), candle(1, 99.5, 101), candle(2, 100, 103), candle(3, 101, 103.5)])
    expect(t).toMatchObject({ target: 102.5, targetFrom: 'GEX R1', outcome: 'target', exitTime: 2 * MIN, r: 1.25 })
  })

  it('a farther GEX level leaves the target alone (it stays a TP2 line)', () => {
    const layer = new FootprintSignalsLayer() as unknown as Inner
    const t = longTrade()
    layer.gexMatch.set('absorb|1|0', { at: { price: 98.5, label: 'S1', strength: 80 }, next: { price: 110, label: 'R2', strength: 70 } })
    layer.useGexTarget(t, [candle(0, 98.5, 101), candle(1, 99.5, 101)])
    expect(t).toMatchObject({ target: 104, outcome: 'open' })
    expect(t.targetFrom).toBeUndefined()
  })

  it('a target hit inside the forming bar is drawn closed at once', () => {
    const layer = new FootprintSignalsLayer() as unknown as Inner
    const t = longTrade()
    layer.formingHit.set('absorb|1|0', 'target')
    expect(layer.shown(t, 5 * MIN)).toMatchObject({ outcome: 'target', exitTime: 5 * MIN, exitPrice: 104, r: 2 })
    expect(t.r).toBeNull() // the record itself settles when the bar closes
  })
})

describe('footprintSignalsLayer — trades do not move with the loaded window', () => {
  // a seeded random walk with prints, 1m bars
  function market(n: number) {
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = []
    const prints: { time: number; price: number; qty: number; buy: boolean }[] = []
    let px = 100
    for (let i = 0; i < n; i++) {
      const t0 = i * MIN
      const open = px
      let hi = px, lo = px
      // volatility picks up in the later bars, as markets do
      const vol = i < 1100 ? 0.12 : 0.4
      for (let k = 0; k < 30; k++) {
        px = Math.max(1, px + (rnd() - 0.5) * vol)
        hi = Math.max(hi, px)
        lo = Math.min(lo, px)
        prints.push({ time: t0 + k * 2000, price: px, qty: 0.5 + rnd() * (rnd() < 0.05 ? 20 : 2), buy: rnd() < 0.5 })
      }
      candles.push({ time: t0, open, high: hi, low: lo, close: px, volume: 1 })
    }
    return { candles, prints }
  }
  const key = (t: FpSignalTrade) => `${t.setup}|${t.side}|${t.signalTime}|${t.entry}|${t.stop}|${t.target}|${t.outcome}|${t.r}`

  it('a refresh later (history starts later, newer bars loaded) leaves every finished trade exactly as it was', () => {
    const { candles, prints } = market(1500)
    const opts = { setups: { stack: true, absorb: true, trap: true, diverge: true }, stretchAtr: 0 }
    // the chart as it was at bar `to`, with history loaded from bar `from`
    const run = (from: number, to: number) => {
      const layer = new FootprintSignalsLayer(opts)
      const c = candles.filter((k) => k.time >= from * MIN && k.time < to * MIN)
      const pr = prints.filter((p) => p.time >= from * MIN && p.time < to * MIN)
      layer.update(c, MIN, 14, [[from * MIN, to * MIN]], [pr], to * MIN, undefined, from * MIN)
      return layer.trades
    }
    const before = run(0, 1100) // first look
    const after = run(400, 1500) // a refresh 400 bars later
    // trades that had finished at the first look, and whose block is still loaded after the refresh
    const firstAfter = Math.min(...after.map((t) => t.signalTime))
    const finished = before.filter((t) => t.r !== null && (t.exitTime as number) < 1099 * MIN && t.signalTime >= firstAfter)
    expect(finished.length).toBeGreaterThan(5)
    const afterKeys = new Set(after.map(key))
    for (const t of finished) expect(afterKeys.has(key(t))).toBe(true)
  })
})
