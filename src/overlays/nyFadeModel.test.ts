import { describe, expect, it } from 'vitest'
import type { Candle } from '../core/types'
import { NY_FADE_DEFAULTS, computeNyFade, fxDayOf, nyFadeStats, nyMinuteOfDay, nyWallToUtc, sessionBlock, type NyFadeOptions } from './nyFadeModel'

/**
 * 1m candles from NY Sunday 17:00 (2026-07-12, EDT) to Wednesday 17:00. Every day has a $5 spike at NY 03:00, so the
 * typical day range is 5. Wednesday's first hour rises 100 -> 102; after 09:00 `after(nyMin)` sets the price.
 */
function week(after: (ny: number) => number, until = nyWallToUtc('2026-07-15', 1020)): Candle[] {
  const price = (t: number): number => {
    const ny = nyMinuteOfDay(t)
    if (fxDayOf(t).key !== '2026-07-15' || ny < 480 || ny >= 1020) return 100
    if (ny < 540) return 100 + (2 * (ny - 480)) / 60
    return after(ny)
  }
  const out: Candle[] = []
  for (let t = nyWallToUtc('2026-07-12', 1020); t < until; t += 60_000) {
    // a bar's close stays inside its own FX day (the 16:59 bar must not take 17:00's price)
    const open = price(t), close = fxDayOf(t + 60_000).key === fxDayOf(t).key ? price(t + 60_000) : open
    const spike = nyMinuteOfDay(t) === 180 ? 5 : 0
    out.push({ time: t, open, high: Math.max(open, close) + spike, low: Math.min(open, close), close, volume: 1 })
  }
  return out
}
// after 09:00: down to 99 by 10:00, then flat
const fadeWorks = (ny: number): number => (ny < 600 ? 102 - (3 * (ny - 540)) / 60 : 99)
const opts = (o: Partial<NyFadeOptions>): NyFadeOptions => ({ ...NY_FADE_DEFAULTS, ...o })

describe('NY first-hour fade model', () => {
  it('fades an up first hour with a short at 09:00 NY, stop 0.25 x typical range, TP1 the hour open, TP2 2R', () => {
    const r = computeNyFade(week(fadeWorks))
    const wed = r.days.find((d) => d.day === '2026-07-15')!
    expect(wed.scale).toBe(5)
    expect(wed.move).toBeCloseTo(2)
    expect(wed.dir).toBe(-1)
    const t = wed.trade!
    expect(t.entryTime).toBe(Date.UTC(2026, 6, 15, 13, 0)) // 09:00 EDT
    expect(t.entry).toBeCloseTo(102)
    expect(t.stop).toBeCloseTo(103.25)
    expect(t.tp1).toBeCloseTo(100)
    expect(t.tp2).toBeCloseTo(99.5)
    // hold to 17:00 NY (the default): exits at the last close before 17:00
    expect(t.exitReason).toBe('Session end')
    expect(t.pnl).toBeCloseTo(3)
    expect(t.r).toBeCloseTo(2.4)
  })

  it('earlier days without a typical range, or with a flat first hour, do not trade', () => {
    const r = computeNyFade(week(fadeWorks))
    expect(r.days.find((d) => d.day === '2026-07-13')!.status).toBe('skipped-no-range')
    expect(r.days.find((d) => d.day === '2026-07-14')!.status).toBe('skipped-small')
    expect(r.trades).toHaveLength(1)
  })

  it('exit modes: TP1, TP2, and half at TP1 with the rest at TP2', () => {
    expect(computeNyFade(week(fadeWorks), opts({ exitMode: 'tp1' })).trades[0]).toMatchObject({ exitReason: 'TP1' })
    expect(computeNyFade(week(fadeWorks), opts({ exitMode: 'tp1' })).trades[0].pnl).toBeCloseTo(2)
    expect(computeNyFade(week(fadeWorks), opts({ exitMode: 'tp2' })).trades[0].pnl).toBeCloseTo(2.5)
    const half = computeNyFade(week(fadeWorks), opts({ exitMode: 'half' })).trades[0]
    expect(half.exitReason).toBe('TP2')
    expect(half.tp1Time).not.toBeNull()
    expect(half.pnl).toBeCloseTo(0.5 * 2 + 0.5 * 2.5)
  })

  it('a move that keeps going hits the stop for -1R', () => {
    const t = computeNyFade(week((ny) => 102 + (2 * (ny - 540)) / 60)).trades[0]
    expect(t.exitReason).toBe('SL')
    expect(t.r).toBeCloseTo(-1)
    expect(nyFadeStats([t])).toMatchObject({ n: 1, wins: 0 })
  })

  it('the first-hour-extreme stop sits just beyond the hour high', () => {
    const t = computeNyFade(week(fadeWorks), opts({ stopMode: 'extreme', extremeBuffer: 0.02 })).trades[0]
    expect(t.stop).toBeCloseTo(102 + 0.02 * 5)
  })

  it('a trade still inside the session stays open', () => {
    const r = computeNyFade(week(fadeWorks, nyWallToUtc('2026-07-15', 700)))
    expect(r.trades[0].exitTime).toBeNull()
    expect(nyFadeStats(r.trades).n).toBe(0)
  })

  it('follows daylight saving: 09:00 NY is 13:00 UTC in July and 14:00 UTC in December', () => {
    expect(nyWallToUtc('2026-07-15', 540)).toBe(Date.UTC(2026, 6, 15, 13, 0))
    expect(nyWallToUtc('2026-12-02', 540)).toBe(Date.UTC(2026, 11, 2, 14, 0))
    expect(nyWallToUtc('2026-11-02', 540)).toBe(Date.UTC(2026, 10, 2, 14, 0)) // the day after the US change
  })

  it('session blocks: Asia, London, New York and rollover by each city clock', () => {
    expect(sessionBlock(Date.UTC(2026, 6, 15, 2, 0))).toBe(1) // Tokyo 11:00
    expect(sessionBlock(Date.UTC(2026, 6, 15, 8, 0))).toBe(2) // London 09:00 BST
    expect(sessionBlock(Date.UTC(2026, 6, 15, 14, 0))).toBe(3) // NY 10:00 EDT
    expect(sessionBlock(Date.UTC(2026, 6, 15, 22, 0))).toBe(0) // NY 18:00
    expect(sessionBlock(Date.UTC(2026, 11, 2, 7, 30))).toBe(1) // London 07:30 GMT: still Asia in winter
  })

  it('refuses bars longer than the first hour', () => {
    const c = week(fadeWorks).filter((_, i) => i % 240 === 0)
    const r = computeNyFade(c)
    expect(r.usable).toBe(false)
    expect(r.trades).toHaveLength(0)
  })
})
