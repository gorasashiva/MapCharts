import { describe, expect, it } from 'vitest'
import type { Candle } from '../core/types'
import { toRenko } from '../chart/chartTransforms'
import { computeRenkoFade, RENKO_FADE_DEFAULTS } from './renkoFadeModel'

const MIN = 60_000
const MON = Date.UTC(2026, 9, 12) // Monday 12 Oct 2026, 00:00 UTC

/** 1m candles whose closes walk through `path`; open = previous close. */
function bars(path: number[], start = MON): Candle[] {
  return path.map((p, i) => {
    const o = i ? path[i - 1] : p
    return { time: start + i * MIN, open: o, high: Math.max(o, p), low: Math.min(o, p), close: p, volume: 1 }
  })
}

const opts = { ...RENKO_FADE_DEFAULTS, box: 1, minRun: 3, targetBoxes: 2, stopBoxes: 3 }

describe('computeRenkoFade', () => {
  it('builds the same bricks as the chart', () => {
    const c = bars([100, 101, 102, 103, 104, 102, 101, 103, 105])
    expect(computeRenkoFade(c, opts).bricks).toEqual(toRenko(c, 1))
  })

  it('fades a 4-brick up run on the reversal brick, fills next open, exits at the target', () => {
    // Up 100→104 (4 bricks), reversal to 102 (first down brick closes 102), then down to 100.
    const c = bars([100, 101, 102, 103, 104, 102, 101, 100, 99.5, 99])
    const r = computeRenkoFade(c, opts)
    expect(r.trades).toHaveLength(1)
    const t = r.trades[0]
    expect(t.dir).toBe(-1)
    expect(t.run).toBe(4)
    expect(t.signalClose).toBe(102)
    expect(t.entryTime).toBe(c[6].time) // bar after the reversal bar (index 5)
    expect(t.entryPrice).toBe(c[6].open)
    expect(t.target).toBe(100)
    expect(t.stop).toBe(105)
    expect(t.exitReason).toBe('TP')
    expect(t.exitTime).toBe(c[8].time) // brick at 100 closes on bar 7 → fill bar 8 open
    expect(t.pnl).toBeCloseTo(c[6].open - c[8].open, 9)
  })

  it('stops out when price runs back against the fade', () => {
    const c = bars([100, 101, 102, 103, 104, 102, 103, 104, 105, 105.5, 106])
    const t = computeRenkoFade(c, opts).trades[0]
    expect(t.exitReason).toBe('SL')
    expect(t.pnl!).toBeLessThan(0)
  })

  it('ignores runs shorter than N and respects direction filters', () => {
    const short = bars([100, 101, 102, 100, 99, 98])
    expect(computeRenkoFade(short, opts).trades).toHaveLength(0)
    const c = bars([100, 101, 102, 103, 104, 102, 101, 100, 99.5, 99])
    expect(computeRenkoFade(c, { ...opts, direction: 'long' }).trades).toHaveLength(0)
  })

  it('no look-ahead: a signal on the last bar is pending, not filled', () => {
    const c = bars([100, 101, 102, 103, 104, 102])
    const r = computeRenkoFade(c, opts)
    expect(r.trades).toHaveLength(0)
    expect(r.pending).toEqual({ dir: -1, ref: 102, target: 100, stop: 105 })
  })

  it('closes at the first weekend bar and takes no weekend entries', () => {
    const fri = Date.UTC(2026, 9, 16, 23, 50) // Friday 23:50 UTC
    const c = bars([100, 101, 102, 103, 104, 102, 101.5, 101.2, 101.4, 101.1, 101.3, 101.2], fri)
    const r = computeRenkoFade(c, opts)
    expect(r.trades).toHaveLength(1)
    expect(r.trades[0].exitReason).toBe('Weekend')
    expect(new Date(r.trades[0].exitTime!).getUTCDay()).toBe(6)
    const sat = bars([100, 101, 102, 103, 104, 102, 101, 100], Date.UTC(2026, 9, 17, 10))
    expect(computeRenkoFade(sat, opts).trades).toHaveLength(0)
    expect(computeRenkoFade(sat, { ...opts, skipWeekends: false }).trades).toHaveLength(1)
  })
})
