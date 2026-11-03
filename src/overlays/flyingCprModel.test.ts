import { describe, expect, it } from 'vitest'
import { computeFlyingCpr, type FcBar } from './flyingCprModel'

const IST = 330 * 60_000
/** A 1-minute bar at IST wall-clock hh:mm on Tue 2026-11-03. */
const at = (hh: number, mm: number, o: number, h: number, l: number, c: number, v = 100): FcBar => ({
  time: Date.UTC(2026, 10, 3, hh, mm) - IST,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: v,
})

describe('flyingCprModel', () => {
  it('builds the 09:31–09:59 IST range, resets at 09:30 and projects the Fib extensions', () => {
    const bars = [at(9, 29, 50, 200, 1, 50), at(9, 30, 100, 300, 0, 100), at(9, 31, 100, 105, 99, 101), at(9, 45, 101, 110, 98, 102), at(10, 0, 102, 500, 90, 103)]
    const r = computeFlyingCpr(bars)
    expect(Number.isNaN(r.sh[1])).toBe(true) // reset bar, before the window
    expect(r.sh[2]).toBe(105)
    expect([r.sh[4], r.sl[4]]).toEqual([110, 98]) // 10:00 is outside the window
    expect(r.up[1][4]).toBeCloseTo(110 + 12 * 2.57)
    expect(r.down[3][4]).toBeCloseTo(98 - 12 * 4.57)
  })

  it('counts a 5m bar toward the range when any of its minutes is in the window', () => {
    const five = (hh: number, mm: number, h: number, l: number): FcBar => ({ ...at(hh, mm, 100, h, l, 100), time: at(hh, mm, 0, 0, 0, 0).time })
    const r = computeFlyingCpr([five(9, 25, 999, 1), five(9, 30, 104, 96), five(9, 55, 106, 95), five(10, 0, 999, 1)])
    expect([r.sh[3], r.sl[3]]).toEqual([106, 95])
  })

  it('follows New York daylight saving when the session is set in New York time', () => {
    const ny = { tz: "America/New_York" as const, sessStart: 570, sessEnd: 599, reset: 569 }
    const one = (t: number): FcBar[] => [{ time: t, open: 1, high: 2, low: 0, close: 1, volume: 1 }, { time: t + 60_000, open: 1, high: 2, low: 0, close: 1, volume: 1 }]
    // 09:30 New York: 13:30 UTC on Tue 27 Oct (EDT), 14:30 UTC on Tue 3 Nov (EST)
    expect(computeFlyingCpr(one(Date.UTC(2026, 9, 27, 13, 30)), ny).sh[0]).toBe(2)
    expect(computeFlyingCpr(one(Date.UTC(2026, 10, 3, 14, 30)), ny).sh[0]).toBe(2)
    expect(Number.isNaN(computeFlyingCpr(one(Date.UTC(2026, 10, 3, 13, 30)), ny).sh[0])).toBe(true)
  })

  it('fires a B sell when a bar wicks through F2.07 and closes back below with a red body', () => {
    const bars: FcBar[] = []
    for (let k = 0; k < 20; k++) bars.push(at(8, 30 + k, 100, 101, 99, 100))
    bars.push(at(9, 31, 100, 101, 99, 100)) // range 99..101 → F2.07 up = 101 + 2 * 2.07 = 105.14
    // 08:00 UTC = 13:30 IST, inside the London filter
    bars.push(at(13, 30, 105, 106, 104, 104.5))
    const r = computeFlyingCpr(bars)
    expect(r.signals).toContainEqual({ index: bars.length - 1, setup: 'B', side: -1 })
  })
})
