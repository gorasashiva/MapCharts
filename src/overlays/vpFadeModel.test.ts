import { describe, expect, it } from 'vitest'
import type { Candle } from '../core/types'
import { computeVpFade } from './vpFadeModel'

const M = 15 * 60_000
const D0 = Date.UTC(2026, 0, 5)

/** Day 1: bars mostly near 105 with a few out to 101 / 109, so POC sits mid-value. */
function dayOne(): Candle[] {
  const out: Candle[] = []
  const offs = [0, 1, -1, 0, 2, -2, 0, 1, -1, 4, -4, 0]
  for (let i = 0; i < 48; i++) {
    const mid = 105 + offs[i % offs.length]
    out.push({ time: D0 + i * M, open: mid - 0.5, high: mid + 1, low: mid - 1, close: mid + 0.5, volume: 10 })
  }
  return out
}

function bar(t: number, o: number, h: number, l: number, c: number): Candle {
  return { time: t, open: o, high: h, low: l, close: c, volume: 10 }
}

/** Levels the model derives for day 2 from day 1 (day 2 here is a flat placeholder). */
function levels(): { vah: number; val: number; poc: number } {
  const d2 = Array.from({ length: 8 }, (_, i) => bar(D0 + 86_400_000 + i * M, 105, 105.2, 104.8, 105))
  const r = computeVpFade([...dayOne(), ...d2], { goldDay: false, costBps: 0 })
  return r.days[0]
}

describe('computeVpFade', () => {
  it('shorts a VAH tag that closes back inside, with stop / T1 / T2 from the prior value', () => {
    const { vah, val, poc } = levels()
    const R = vah - val
    const t = D0 + 86_400_000
    const open = vah - 0.25 * R // opens inside value, near the top so T1 (POC) is ≥ 2R away
    const d2 = [
      bar(t, open, open + 0.1, open - 0.1, open),
      bar(t + M, open, vah + 0.05 * R, open - 0.1, vah - 0.02 * R), // tags VAH, closes back inside
      bar(t + 2 * M, vah - 0.02 * R, vah - 0.01 * R, poc - 0.01, poc + 0.1), // reaches T1
      bar(t + 3 * M, poc, poc + 0.01, val, val + 0.1 * R), // reaches T2
      ...Array.from({ length: 6 }, (_, i) => bar(t + (4 + i) * M, val + 0.2 * R, val + 0.3 * R, val + 0.15 * R, val + 0.2 * R)),
    ]
    const tomorrow = bar(t + 86_400_000, 105, 105, 105, 105)
    const r = computeVpFade([...dayOne(), ...d2, tomorrow], { goldDay: false, costBps: 0, stopK: 0.1 })
    const s = r.signals.find((x) => x.side === 'short')
    expect(s).toBeDefined()
    if (!s) return
    expect(s.entry).toBeCloseTo(vah - 0.02 * R)
    expect(s.stop).toBeCloseTo(vah + 0.1 * R)
    expect(s.t1).toBeCloseTo(poc)
    expect(s.t2).toBeCloseTo(val + 0.08 * R)
    expect(s.rr1).toBeGreaterThanOrEqual(2)
    expect(s.taken).toBe(true)
    expect(s.exit?.reason).toBe('T1+T2')
    expect(s.exit?.grossR).toBeCloseTo(0.5 * s.rr1 + 0.5 * s.rr2)
  })

  it('reports but does not take a tag whose T1 is closer than the minimum R:R', () => {
    const { vah, val, poc } = levels()
    const R = vah - val
    const t = D0 + 86_400_000
    const open = vah - 0.25 * R
    const d2 = [
      bar(t, open, open + 0.1, open - 0.1, open),
      bar(t + M, open, vah + 0.05 * R, open - 0.1, vah - 0.1 * R),
      ...Array.from({ length: 8 }, (_, i) => bar(t + (2 + i) * M, poc + 0.3 * R, poc + 0.35 * R, poc + 0.25 * R, poc + 0.3 * R)),
    ]
    const r = computeVpFade([...dayOne(), ...d2], { goldDay: false, costBps: 0, minRR: 50 })
    const s = r.signals.find((x) => x.side === 'short')
    expect(s?.taken).toBe(false)
    expect(s?.exit).toBeNull()
  })

  it('stops out at the stop', () => {
    const { vah, val } = levels()
    const R = vah - val
    const t = D0 + 86_400_000
    const open = vah - 0.25 * R
    const d2 = [
      bar(t, open, open + 0.1, open - 0.1, open),
      bar(t + M, open, vah + 0.05 * R, open - 0.1, vah - 0.02 * R),
      bar(t + 2 * M, vah - 0.02 * R, vah + 0.5 * R, vah - 0.03 * R, vah + 0.4 * R), // through the stop
      ...Array.from({ length: 6 }, (_, i) => bar(t + (3 + i) * M, vah + 0.4 * R, vah + 0.5 * R, vah + 0.3 * R, vah + 0.4 * R)),
    ]
    const r = computeVpFade([...dayOne(), ...d2], { goldDay: false, costBps: 0, stopK: 0.1 })
    const s = r.signals.find((x) => x.side === 'short')
    expect(s?.exit?.reason).toBe('SL')
    expect(s?.exit?.grossR).toBeCloseTo(-1)
  })

  it('does not trade a day that opens outside the prior value', () => {
    const { vah, val } = levels()
    const R = vah - val
    const t = D0 + 86_400_000
    const d2 = Array.from({ length: 10 }, (_, i) => bar(t + i * M, vah + R, vah + 1.1 * R, vah - 0.1 * R, vah - 0.05 * R))
    const r = computeVpFade([...dayOne(), ...d2], { goldDay: false })
    expect(r.days[0].open).toBe('above')
    expect(r.signals).toHaveLength(0)
  })
})
