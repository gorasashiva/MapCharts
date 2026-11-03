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
