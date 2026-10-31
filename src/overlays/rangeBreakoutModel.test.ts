import { describe, expect, it } from 'vitest'
import { computeRangeBreakout, type RbBar } from './rangeBreakoutModel'

const M5 = 5 * 60_000
const bar = (t: number, o: number, h: number, l: number, c: number): RbBar => ({ time: t, open: o, high: h, low: l, close: c })

/** 05:30–05:45 IST = 00:00–00:15 UTC. Range 100–101, breakout close 101.5 at 00:15, then a rally (or a drift). */
function day(d0: number, rally = true): RbBar[] {
  const out = [bar(d0, 100.5, 101, 100, 100.6), bar(d0 + M5, 100.6, 100.9, 100.2, 100.4), bar(d0 + 2 * M5, 100.4, 100.8, 100.1, 100.7)]
  out.push(bar(d0 + 3 * M5, 100.7, 101.6, 100.6, 101.5)) // 00:15 UTC: closes above the range high -> long signal
  for (let k = 0; k < 12; k++) {
    const c = rally ? 101.5 + (k + 1) * 0.5 : 101.5 - (k + 1) * 0.1
    out.push(bar(d0 + (4 + k) * M5, rally ? c - 0.5 : c + 0.1, rally ? c + 0.1 : c + 0.15, rally ? c - 0.55 : c - 0.05, c))
  }
  return out
}
const MON = Date.UTC(2026, 9, 5) // Mon 5 Oct 2026
const FRI = Date.UTC(2026, 9, 9)

describe('computeRangeBreakout', () => {
  it('goes long on a close above the range, fills next open, stop at range low, 3R target hit', () => {
    const r = computeRangeBreakout(day(MON))
    expect(r.days[0]).toMatchObject({ start: MON, high: 101, low: 100, readyTime: MON + 3 * M5, tradable: true })
    expect(r.signals).toEqual([{ time: MON + 3 * M5, dir: 1 }])
    const t = r.trades[0]
    expect(t).toMatchObject({ dir: 1, entryTime: MON + 4 * M5, entry: 101.5, stop: 100, exitReason: 'TP' })
    expect(t.target).toBeCloseTo(101.5 + 3 * 1.5, 9)
    expect(t.exitPrice).toBeCloseTo(106, 9)
    expect(t.r).toBeCloseTo(3, 9)
    expect(t.qty).toBeCloseTo((10_000 * 0.1) / 101.5, 9) // 10% of equity at the signal close
    expect(r.equity).toBeCloseTo(10_000 + 4.5 * t.qty, 6)
  })

  it('bar replay: a clipped series leaves the trade open at the cursor', () => {
    const t = computeRangeBreakout(day(MON).slice(0, 7)).trades[0]
    expect(t.exitTime).toBeNull()
    expect(t.entry).toBe(101.5)
    // cursor on the signal bar: the order is pending, no trade yet
    const p = computeRangeBreakout(day(MON).slice(0, 4))
    expect(p.trades).toHaveLength(0)
    expect(p.pending).toMatchObject({ dir: 1, stop: 100 })
  })

  it('skips Fridays by default, and weekends', () => {
    expect(computeRangeBreakout(day(FRI)).trades).toHaveLength(0)
    expect(computeRangeBreakout(day(FRI), { skipFriday: false }).trades).toHaveLength(1)
    expect(computeRangeBreakout(day(Date.UTC(2026, 9, 10))).trades).toHaveLength(0) // Saturday
  })

  it('closes a still-open trade at the next day range start (next open)', () => {
    // Tuesday shifted +2 so its bars never touch Monday's stop (100) before the close-out fills
    const tue = day(MON + 86_400_000).map((b) => ({ ...b, open: b.open + 2, high: b.high + 2, low: b.low + 2, close: b.close + 2 }))
    const r = computeRangeBreakout([...day(MON, false), ...tue])
    const t = r.trades[0]
    expect(t.exitReason).toBe('New day')
    expect(t.exitTime).toBe(MON + 86_400_000 + M5) // the bar after Tuesday's first range bar
  })

  it('profit lock moves the stop after +0.75R, from the next bar', () => {
    const t = computeRangeBreakout(day(MON), { useLock: true }).trades[0]
    expect(t.stopMoves).toHaveLength(1)
    expect(t.stopMoves[0].price).toBeCloseTo(101.5 + 0.25 * 1.5, 9)
  })

  it('refuses timeframes above 15 minutes, like the Pine script', () => {
    const h1 = [bar(MON, 1, 1, 1, 1), bar(MON + 3_600_000, 1, 1, 1, 1)]
    expect(computeRangeBreakout(h1).tfTooLarge).toBe(true)
  })
})
