import { describe, expect, it } from 'vitest'
import type { Candle } from '../core/types'
import { computeTpoStrategies, openStructure, resolveSignal, type StrategySignal } from './tpoStrategyModel'

const MIN = 60_000
const bar = (t: number, o: number, h: number, l: number, c: number): Candle => ({ time: t, open: o, high: h, low: l, close: c, volume: 1 })

describe('openStructure', () => {
  const prev = { vah: 100, val: 90 }

  it('calls a one-way move without retest an open drive', () => {
    const win = [bar(0, 95, 96, 95, 96), bar(5 * MIN, 96, 98, 96, 98), bar(10 * MIN, 98, 99, 97.5, 99)]
    expect(openStructure(win, 95, prev, 0.5)).toBe('Open drive up')
  })

  it('calls a move that trades back through the open an auction', () => {
    const win = [bar(0, 95, 97, 95, 97), bar(5 * MIN, 97, 97, 94.5, 95)]
    expect(openStructure(win, 95, prev, 0.5)).toBe('Open auction')
  })

  it('calls an open above prior value that is probed and rejected a rejection', () => {
    const win = [bar(0, 101, 103, 100.5, 102), bar(5 * MIN, 102, 102, 99, 99.5)]
    expect(openStructure(win, 101, prev, 0.5)).toBe('Open rejection')
  })
})

describe('resolveSignal', () => {
  const base: StrategySignal = { t: 0, side: 'long', strategy: 'Trend Day', entry: 100, stop: 98, target: 104, day: 0 }

  it('wins at the target', () => {
    const exit = resolveSignal(base, [bar(MIN, 100, 101, 99.5, 101), bar(2 * MIN, 101, 104.5, 100, 104)])
    expect(exit?.result).toBe('win')
    expect(exit?.r).toBeCloseTo(2, 9)
  })

  it('loses at the stop, and the stop wins when a bar touches both', () => {
    const exit = resolveSignal(base, [bar(MIN, 100, 105, 97, 101)])
    expect(exit?.result).toBe('loss')
    expect(exit?.r).toBe(-1)
  })

  it('ends a trade still open at the last bar at its close', () => {
    const exit = resolveSignal(base, [bar(MIN, 100, 101, 99.5, 100.5)])
    expect(exit?.result).toBe('end')
    expect(exit?.r).toBeCloseTo(0.25, 9)
  })
})

describe('computeTpoStrategies', () => {
  it('runs over several days of candles and resolves every signal it returns', () => {
    const candles: Candle[] = []
    let price = 100
    let t = Date.UTC(2026, 10, 2, 0, 0)
    for (let i = 0; i < 3 * 24 * 12; i++) {
      const o = price
      price += Math.sin(i / 7) * 0.4
      candles.push(bar(t, o, Math.max(o, price) + 0.2, Math.min(o, price) - 0.2, price))
      t += 5 * MIN
    }
    const r = computeTpoStrategies(candles, undefined, t)
    for (const s of r.signals) expect(s.exit).toBeDefined()
    for (const d of r.days) expect(['Open drive up', 'Open drive down', 'Open rejection', 'Open auction']).toContain(d.openType)
  })
})
