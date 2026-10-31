import { describe, expect, it } from 'vitest'
import { computeVortex, type VortexBar } from './vortexModel'

/** Straight from the script: sums recomputed over every window. */
function naive(bars: VortexBar[], len: number): { plus: (number | null)[]; minus: (number | null)[] } {
  const plus: (number | null)[] = bars.map(() => null)
  const minus: (number | null)[] = bars.map(() => null)
  for (let i = len; i < bars.length; i++) {
    let sp = 0
    let sm = 0
    let st = 0
    for (let k = i - len + 1; k <= i; k++) {
      const b = bars[k]
      const p = bars[k - 1]
      sp += Math.abs(b.high - p.low)
      sm += Math.abs(b.low - p.high)
      st += Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close))
    }
    plus[i] = sp / st
    minus[i] = sm / st
  }
  return { plus, minus }
}

describe('vortexModel', () => {
  const bars: VortexBar[] = []
  let p = 100
  let seed = 7
  const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (let i = 0; i < 300; i++) {
    const c = p + (rnd() - 0.5) * 4
    bars.push({ high: Math.max(p, c) + rnd() * 2, low: Math.min(p, c) - rnd() * 2, close: c })
    p = c
  }

  it('matches a brute-force window sum', () => {
    const fast = computeVortex(bars, 14)
    const slow = naive(bars, 14)
    for (let i = 0; i < bars.length; i++) {
      if (slow.plus[i] === null) expect(fast.plus[i]).toBeNull()
      else {
        expect(fast.plus[i]).toBeCloseTo(slow.plus[i]!, 9)
        expect(fast.minus[i]).toBeCloseTo(slow.minus[i]!, 9)
      }
    }
  })

  it('is null until a full window exists', () => {
    const r = computeVortex(bars, 14)
    expect(r.plus.slice(0, 14).every((v) => v === null)).toBe(true)
    expect(r.plus[14]).not.toBeNull()
  })

  it('VI+ dominates in a steady up-trend', () => {
    const up: VortexBar[] = Array.from({ length: 40 }, (_, i) => ({ high: 101 + i, low: 99 + i, close: 100.5 + i }))
    const r = computeVortex(up, 14)
    expect(r.plus[39]!).toBeGreaterThan(r.minus[39]!)
  })
})
