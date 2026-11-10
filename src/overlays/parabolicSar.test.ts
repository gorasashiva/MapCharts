import { describe, expect, it } from 'vitest'
import { parabolicSar } from './parabolicSar'
import type { Candle } from '../core/types'

const bar = (i: number, h: number, l: number, c: number): Candle =>
  ({ time: i * 60, open: c, high: h, low: l, close: c, volume: 1 }) as Candle

describe('parabolicSar', () => {
  it('stays below the lows and never falls in a steady uptrend', () => {
    const candles: Candle[] = []
    for (let i = 0; i < 30; i++) {
      const base = 100 + i
      candles.push(bar(i, base + 1, base - 0.5, base + 0.8))
    }
    const sar = parabolicSar(candles)
    expect(sar[0]).toBeNull()
    for (let i = 1; i < candles.length; i++) {
      expect(sar[i]).not.toBeNull()
      expect(sar[i]!).toBeLessThan(candles[i].low)
      if (i > 1) expect(sar[i]!).toBeGreaterThanOrEqual(sar[i - 1]! - 1e-9)
    }
  })

  it('flips above price after a sharp drop through the SAR', () => {
    const candles: Candle[] = []
    for (let i = 0; i < 20; i++) {
      const base = 100 + i
      candles.push(bar(i, base + 1, base - 0.5, base + 0.8))
    }
    // a crash bar trades well below the rising SAR, then price keeps falling
    candles.push(bar(20, 118.5, 105, 106))
    candles.push(bar(21, 106.5, 104, 104.5))
    const sar = parabolicSar(candles)
    expect(sar[20]!).toBeGreaterThan(candles[20].close)
    expect(sar[21]!).toBeGreaterThan(candles[21].close)
  })
})
