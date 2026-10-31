import { describe, expect, it } from 'vitest'
import { computeZigzagFib, inZzFibSession, type ZzFibBar } from './zigzagFibModel'

const M5 = 300_000
const T0 = Date.UTC(2026, 9, 5, 7) // Mon 5 Oct 2026 07:00 UTC

/** One bar per close, ±0.1 around it (so turning points have a unique high / low). */
function series(closes: number[]): ZzFibBar[] {
  return closes.map((c, i) => ({ time: T0 + i * M5, open: c, high: c + 0.1, low: c - 0.1, close: c }))
}
const ramp = (a: number, b: number): number[] => {
  const out: number[] = []
  const step = a < b ? 1 : -1
  for (let v = a; step > 0 ? v <= b : v >= b; v += step) out.push(v)
  return out
}
const ANY_TIME = { sessionStartUTC: 0, sessionEndUTC: 0, weekdaysOnly: false, minStopBps: 0, minLegAtr: 0, depth: 2 }

describe('computeZigzagFib', () => {
  // 104 -> 100 (low) -> 110 (high) -> pullback 106 -> rally 114
  const bars = series([...ramp(104, 100), ...ramp(101, 110), ...ramp(109, 106), ...ramp(107, 114)])

  it('buys the 0.382 pullback of an up leg and hits the -0.272 target', () => {
    const r = computeZigzagFib(bars, ANY_TIME)
    const long = r.setups.find((s) => s.dir === 1 && s.status === 'closed')
    expect(long).toBeDefined()
    const range = long!.legEnd.price - long!.legStart.price
    expect(long!.entry).toBeCloseTo(long!.legEnd.price - 0.382 * range, 6)
    expect(long!.stop).toBeCloseTo(long!.legEnd.price - 1.05 * range, 6)
    expect(long!.target).toBeCloseTo(long!.legEnd.price + 0.272 * range, 6)
    expect(long!.exitReason).toBe('TP')
    expect(long!.r).toBeGreaterThan(0)
    expect(r.stats.trades).toBeGreaterThan(0)
  })

  it('arms an order only after the pivot is confirmed (no look-ahead)', () => {
    const r = computeZigzagFib(bars, ANY_TIME)
    for (const s of r.setups) expect(s.armedTime).toBeGreaterThan(s.legEnd.time + 2 * M5)
  })

  it('skips setups whose stop is tighter than minStopBps', () => {
    const r = computeZigzagFib(bars, { ...ANY_TIME, minStopBps: 5000 })
    expect(r.setups).toHaveLength(0)
  })

  it('does not fill outside the session window', () => {
    // Session 00:00-01:00 UTC never overlaps these 07:00+ bars.
    const r = computeZigzagFib(bars, { ...ANY_TIME, sessionStartUTC: 0, sessionEndUTC: 1 })
    expect(r.setups.every((s) => s.fillTime === undefined)).toBe(true)
  })
})

describe('inZzFibSession', () => {
  const lon = { sessionStartUTC: 7, sessionEndUTC: 12, weekdaysOnly: true }
  it('London window, weekdays only', () => {
    expect(inZzFibSession(Date.UTC(2026, 9, 5, 7, 0), lon)).toBe(true)
    expect(inZzFibSession(Date.UTC(2026, 9, 5, 11, 55), lon)).toBe(true)
    expect(inZzFibSession(Date.UTC(2026, 9, 5, 12, 0), lon)).toBe(false)
    expect(inZzFibSession(Date.UTC(2026, 9, 10, 8), lon)).toBe(false) // Saturday
  })
  it('wraps past midnight', () => {
    const o = { sessionStartUTC: 22, sessionEndUTC: 2, weekdaysOnly: false }
    expect(inZzFibSession(Date.UTC(2026, 9, 5, 23), o)).toBe(true)
    expect(inZzFibSession(Date.UTC(2026, 9, 5, 1), o)).toBe(true)
    expect(inZzFibSession(Date.UTC(2026, 9, 5, 3), o)).toBe(false)
  })
})
